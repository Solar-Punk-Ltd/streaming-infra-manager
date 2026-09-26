import { isIP } from 'node:net';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';

export interface ObservedBeeContainer {
  readonly daemonId: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly project: string;
  readonly service: 'bee-uploader';
  readonly networkMode: string;
  readonly internalPort: number;
  readonly publishedBindings: readonly { readonly hostIp: string; readonly hostPort: number }[];
}

const UNSHARED_NETWORK_MODES = ['host', 'none'];

export function requireBeeBindingTarget(binding: ObservedBeeContainer, expected: FrozenChequebookTarget): void {
  if (!binding || binding.daemonId !== expected.daemonId || binding.project !== expected.profile.name || binding.service !== expected.reservation.service ||
      typeof binding.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(binding.containerId) || typeof binding.imageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.imageId)) throw new DockerBeeAcquisitionError('target_changed');
  if (!Number.isSafeInteger(binding.internalPort) || binding.internalPort < 1 || binding.internalPort > 65535 ||
      typeof binding.networkMode !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(binding.networkMode) || UNSHARED_NETWORK_MODES.includes(binding.networkMode) ||
      !Array.isArray(binding.publishedBindings) || !binding.publishedBindings.length || binding.publishedBindings.some(value =>
        !value || value.hostPort !== expected.reservation.port || typeof value.hostIp !== 'string' || !/^[a-fA-F0-9:.]+$/.test(value.hostIp) || !isIP(value.hostIp))) {
    throw new DockerBeeAcquisitionError('bee_container_unsupported');
  }
}

export function dockerObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DockerBeeAcquisitionError();
  return input as Record<string, unknown>;
}

export function fullDockerId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new DockerBeeAcquisitionError();
  return input;
}

function requireLabels(input: unknown, expected: FrozenChequebookTarget): void {
  const labels = dockerObject(input);
  if (labels['com.docker.compose.project'] !== expected.profile.name || labels['com.docker.compose.service'] !== 'bee-uploader') {
    throw new DockerBeeAcquisitionError('target_changed');
  }
}

export function listedBeeContainer(input: unknown, expected: FrozenChequebookTarget): string {
  if (!Array.isArray(input)) throw new DockerBeeAcquisitionError();
  if (input.length === 0) throw new DockerBeeAcquisitionError('bee_container_not_found');
  if (input.length !== 1) throw new DockerBeeAcquisitionError('target_changed');
  const candidate = dockerObject(input[0]);
  requireLabels(candidate.Labels, expected);
  return fullDockerId(candidate.Id);
}

function port(input: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(input) || Number(input) > 65535) throw new DockerBeeAcquisitionError();
  return Number(input);
}

const CHAIN_ENDPOINT_FLAG = '--blockchain-rpc-endpoint';

/**
 * The chain endpoint a Bee container was started with, from the command in its
 * inspect, or null when it names none. Bee's flag parser takes the flag as one
 * word with `=` or as two words, and the last occurrence wins, so this does
 * the same. The value is not checked here: the chain registry holds it to the
 * shape rules of a configured endpoint, and it is never logged or answered.
 */
export function nodeChainEndpoint(inspect: unknown): string | null {
  const config = inspect && typeof inspect === 'object' ? (inspect as Record<string, unknown>).Config : undefined;
  const command = config && typeof config === 'object' ? (config as Record<string, unknown>).Cmd : undefined;
  if (!Array.isArray(command)) return null;
  let endpoint: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const word = command[index];
    if (typeof word !== 'string') continue;
    if (word.startsWith(`${CHAIN_ENDPOINT_FLAG}=`)) endpoint = word.slice(CHAIN_ENDPOINT_FLAG.length + 1);
    else if (word === CHAIN_ENDPOINT_FLAG) {
      const next = command[index + 1];
      endpoint = typeof next === 'string' ? next : null;
      index++;
    }
  }
  return endpoint || null;
}

/** Drops unneeded inspect fields, including environment values, before returning immutable evidence. */
export function observedBeeContainer(input: unknown, containerId: string, expected: FrozenChequebookTarget): ObservedBeeContainer {
  const inspect = dockerObject(input);
  if (inspect.Id !== containerId) throw new DockerBeeAcquisitionError('target_changed');
  requireLabels(dockerObject(inspect.Config).Labels, expected);
  const state = dockerObject(inspect.State);
  if (state.Running !== true || state.Paused !== false || state.Restarting !== false || state.Dead !== false) {
    throw new DockerBeeAcquisitionError('bee_container_not_found');
  }
  const imageId = inspect.Image;
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new DockerBeeAcquisitionError();
  const networkMode = dockerObject(inspect.HostConfig).NetworkMode;
  if (typeof networkMode !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(networkMode)) throw new DockerBeeAcquisitionError();
  if (UNSHARED_NETWORK_MODES.includes(networkMode)) throw new DockerBeeAcquisitionError('bee_container_unsupported');
  const ports = dockerObject(dockerObject(inspect.NetworkSettings).Ports);
  let internalPort: number | undefined;
  const bindings: { readonly hostIp: string; readonly hostPort: number }[] = [];
  for (const [key, value] of Object.entries(ports)) {
    if (!/^[1-9][0-9]{0,4}\/(tcp|udp|sctp)$/.test(key)) throw new DockerBeeAcquisitionError();
    const [number, protocol] = key.split('/');
    const candidatePort = port(number!);
    if (value === null) continue;
    if (!Array.isArray(value)) throw new DockerBeeAcquisitionError();
    for (const entry of value) {
      const binding = dockerObject(entry);
      if (typeof binding.HostPort !== 'string') throw new DockerBeeAcquisitionError();
      const hostPort = port(binding.HostPort);
      if (protocol !== 'tcp' || hostPort !== expected.reservation.port) continue;
      const hostIp = binding.HostIp;
      if (typeof hostIp !== 'string' || !/^[a-fA-F0-9:.]+$/.test(hostIp) || !isIP(hostIp) ||
          (internalPort !== undefined && internalPort !== candidatePort) || bindings.some(saved => saved.hostIp === hostIp)) throw new DockerBeeAcquisitionError('bee_container_unsupported');
      internalPort = candidatePort;
      bindings.push(Object.freeze({ hostIp, hostPort }));
    }
  }
  if (internalPort === undefined || !bindings.length) throw new DockerBeeAcquisitionError('bee_container_unsupported');
  return Object.freeze({ daemonId: expected.daemonId, containerId, imageId, project: expected.profile.name, service: 'bee-uploader',
    networkMode, internalPort, publishedBindings: Object.freeze(bindings) });
}
