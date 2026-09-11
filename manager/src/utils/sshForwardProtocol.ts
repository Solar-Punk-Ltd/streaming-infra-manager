import { posix } from 'node:path';
import { DockerBeeAcquisitionError } from '../domain/errors/DockerBeeAcquisitionError.js';
import { sshDockerForwardCommand, type SshDockerForwardCommand, type TrustedSshDockerLocator } from '../domain/chequebook/sshDockerForwardCommand.js';
import type { ForwardPathIdentity, SshForwardCleanup, OwnedForwardPath } from './sshForwardResources.js';
export type { OwnedForwardPath } from './sshForwardResources.js';

/** Private parent/supervisor IPC. Absolute hrtime deadlines share the same host clock, never a wall clock or renewed duration. */
export interface ForwardStart {
  readonly type: 'start';
  readonly leaseId: string;
  readonly locator: TrustedSshDockerLocator;
  readonly directory: OwnedForwardPath;
  readonly socketPath: string;
  readonly acquisitionDeadlineNs: string;
  readonly operationalDeadlineNs: string;
  readonly cleanupDeadlineNs: string;
}
export interface ForwardReady { readonly type: 'ready'; readonly leaseId: string; readonly directory: OwnedForwardPath; readonly socket: OwnedForwardPath }
export interface ForwardCleanupReceipt {
  readonly type: 'cleanup'; readonly leaseId: string; readonly directory: OwnedForwardPath;
  readonly socket: OwnedForwardPath | null; readonly outcome: SshForwardCleanup;
}
export interface ValidatedForwardStart {
  readonly start: ForwardStart; readonly command: SshDockerForwardCommand;
  readonly acquisitionDeadline: bigint; readonly operationalDeadline: bigint; readonly cleanupDeadline: bigint;
}
export const NS_PER_MS = 1_000_000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exact(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== fields) throw new DockerBeeAcquisitionError();
  return value as Record<string, unknown>;
}
function deadline(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,20})$/.test(value)) throw new DockerBeeAcquisitionError();
  return BigInt(value);
}
export function privateForwardIdentity(value: unknown, kind: 'directory' | 'socket', uid: number): ForwardPathIdentity {
  const identity = exact(value, 'dev,ino,kind,mode,uid');
  if (identity.kind !== kind || identity.uid !== uid || identity.mode !== (kind === 'directory' ? 0o700 : 0o600) ||
      typeof identity.dev !== 'string' || !/^[0-9]{1,30}$/.test(identity.dev) || typeof identity.ino !== 'string' || !/^[0-9]{1,30}$/.test(identity.ino)) throw new DockerBeeAcquisitionError();
  return Object.freeze({ kind, dev: identity.dev, ino: identity.ino, uid, mode: kind === 'directory' ? 0o700 : 0o600 });
}
export function sameForwardIdentity(left: ForwardPathIdentity | null, right: ForwardPathIdentity): boolean {
  return !!left && left.kind === right.kind && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

/** Rebuild the fixed argv. No executable, argv, environment or arbitrary options can enter through IPC. */
export function validateForwardStart(input: unknown, now: bigint, uid: number): ValidatedForwardStart {
  try {
    const value = exact(structuredClone(input), 'acquisitionDeadlineNs,cleanupDeadlineNs,directory,leaseId,locator,operationalDeadlineNs,socketPath,type');
    if (value.type !== 'start' || typeof value.leaseId !== 'string' || !UUID.test(value.leaseId) || !Number.isSafeInteger(uid) || uid < 0 || now < 0n) throw new DockerBeeAcquisitionError();
    const acquisitionDeadline = deadline(value.acquisitionDeadlineNs); const operationalDeadline = deadline(value.operationalDeadlineNs); const cleanupDeadline = deadline(value.cleanupDeadlineNs);
    if (acquisitionDeadline <= now || acquisitionDeadline - now > 30_000n * NS_PER_MS || operationalDeadline <= acquisitionDeadline ||
        operationalDeadline - acquisitionDeadline > 240_000n * NS_PER_MS || cleanupDeadline <= operationalDeadline || cleanupDeadline - operationalDeadline > 10_000n * NS_PER_MS) throw new DockerBeeAcquisitionError();
    const directory = exact(value.directory, 'identity,path');
    if (typeof directory.path !== 'string' || directory.path === '/' || !posix.isAbsolute(directory.path) || posix.normalize(directory.path) !== directory.path ||
        value.socketPath !== `${directory.path}/docker.sock`) throw new DockerBeeAcquisitionError();
    const identity = privateForwardIdentity(directory.identity, 'directory', uid);
    const locator = value.locator as TrustedSshDockerLocator;
    const command = sshDockerForwardCommand(locator?.alias, locator, { localSocketPath: value.socketPath, acquisitionTimeoutMs: Number((acquisitionDeadline - now + NS_PER_MS - 1n) / NS_PER_MS) });
    const start: ForwardStart = Object.freeze({ type: 'start', leaseId: value.leaseId, locator: command.target,
      directory: Object.freeze({ path: directory.path, identity }), socketPath: value.socketPath as string,
      acquisitionDeadlineNs: String(acquisitionDeadline), operationalDeadlineNs: String(operationalDeadline), cleanupDeadlineNs: String(cleanupDeadline) });
    return Object.freeze({ start, command, acquisitionDeadline, operationalDeadline, cleanupDeadline });
  } catch { throw new DockerBeeAcquisitionError(); }
}

export function isForwardStop(value: unknown, leaseId: string): boolean {
  try { const record = exact(value, 'leaseId,type'); return record.type === 'stop' && record.leaseId === leaseId; }
  catch { return false; }
}
