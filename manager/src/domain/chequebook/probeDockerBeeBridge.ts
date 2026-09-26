import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { observeBeeBridgeTarget, openDockerConversation, type DockerBeeAcquisitionOptions, type ObservedBeeBridgeTarget,
  type OwnedDockerConversation } from './acquireDockerBeeStream.js';
import { beeBridgeCheckCommand, beeBridgeCheckVerdict, type BeeBridgeCheckVerdict } from './beeBridgeCheck.js';
import type { BeeBridgeExecution } from './beeBridgeQualification.js';
import { createDockerExecDuplex } from './createDockerExecDuplex.js';
import { dockerObject, fullDockerId } from './DockerBeeBinding.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';

/** The check prints a few short lines, so anything longer is not its answer. */
const CHECK_ANSWER_BYTES = 4096;

export interface BeeBridgeProbe {
  readonly observed: ObservedBeeBridgeTarget;
  /** What the check found, when this probe ran it. */
  readonly verdict: BeeBridgeCheckVerdict | null;
}

/**
 * On a short-lived connection of its own, before the bridge's: reads the
 * container and the execution the bridge would use and, only when `needsCheck`
 * says nothing qualifies that execution yet, runs the check in that container
 * and reads its answer. It never starts the bridge, and it closes the
 * connection whatever happens. It cannot share the bridge's connection, because
 * starting an exec that is read takes over the connection it runs on.
 */
export async function probeDockerBeeBridge(transport: Duplex, expected: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions,
  needsCheck: (execution: BeeBridgeExecution) => Promise<boolean>, signal?: AbortSignal, acquisitionDeadline?: number): Promise<BeeBridgeProbe> {
  let conversation: OwnedDockerConversation | undefined;
  try {
    conversation = openDockerConversation(transport, expected, options, signal, acquisitionDeadline);
    const observed = await observeBeeBridgeTarget(conversation);
    if (!await needsCheck(observed.execution)) return Object.freeze({ observed, verdict: null });
    conversation.handshake.requireActive();
    return Object.freeze({ observed, verdict: beeBridgeCheckVerdict(await checkAnswer(conversation, observed.containerId, signal)) });
  } catch (error) {
    throw DockerBeeAcquisitionError.keeping(error);
  } finally {
    conversation?.handshake.destroy();
    conversation?.owned.destroy();
    if (!conversation && !transport.destroyed) transport.destroy();
  }
}

/**
 * Runs the check and reads its framed answer. A failure before Docker agreed
 * to start it is Docker's, and refuses. Anything after that which is not a
 * whole answer reads as no answer, which the verdict names.
 */
async function checkAnswer(conversation: OwnedDockerConversation, containerId: string, signal?: AbortSignal): Promise<string> {
  const { handshake, owned } = conversation;
  const created = dockerObject(await handshake.json('POST', `/containers/${containerId}/exec`, 201, {
    AttachStdin: false, AttachStdout: true, AttachStderr: false, Tty: false, Privileged: false, Cmd: beeBridgeCheckCommand(),
  }));
  await handshake.upgrade(fullDockerId(created.Id));
  handshake.requireActive();
  const output = createDockerExecDuplex(owned, { maxFrameBytes: CHECK_ANSWER_BYTES, maxOutputBytes: CHECK_ANSWER_BYTES, maxInputBytes: 1,
    totalTimeoutMs: Math.max(1, Math.ceil(conversation.deadline - performance.now())) }, signal);
  handshake.release();
  return new Promise<string>(resolve => {
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    output.once('error', () => resolve(''));
  });
}
