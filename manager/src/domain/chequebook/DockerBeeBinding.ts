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
  if (labels['com.docker.compose.project'] !== expected.profile.name || labels['com.docker.compose.service'] !== 'bee-uploader') throw new DockerBeeAcquisitionError();
}

export function listedBeeContainer(input: unknown, expected: FrozenChequebookTarget): string {
  if (!Array.isArray(input) || input.length !== 1) throw new DockerBeeAcquisitionError();
  const candidate = dockerObject(input[0]);
  requireLabels(candidate.Labels, expected);
  return fullDockerId(candidate.Id);
}

function port(input: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(input) || Number(input) > 65535) throw new DockerBeeAcquisitionError();
  return Number(input);
}

/** Drops unneeded inspect fields, including environment values, before returning immutable evidence. */
export function observedBeeContainer(input: unknown, containerId: string, expected: FrozenChequebookTarget): ObservedBeeContainer {
  const inspect = dockerObject(input);
  if (inspect.Id !== containerId) throw new DockerBeeAcquisitionError();
  requireLabels(dockerObject(inspect.Config).Labels, expected);
  const state = dockerObject(inspect.State);
  if (state.Running !== true || state.Paused !== false || state.Restarting !== false || state.Dead !== false) throw new DockerBeeAcquisitionError();
  const imageId = inspect.Image;
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new DockerBeeAcquisitionError();
  const networkMode = dockerObject(inspect.HostConfig).NetworkMode;
  if (typeof networkMode !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(networkMode) || ['host', 'none'].includes(networkMode)) throw new DockerBeeAcquisitionError();
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
          (internalPort !== undefined && internalPort !== candidatePort) || bindings.some(saved => saved.hostIp === hostIp)) throw new DockerBeeAcquisitionError();
      internalPort = candidatePort;
      bindings.push(Object.freeze({ hostIp, hostPort }));
    }
  }
  if (internalPort === undefined || !bindings.length) throw new DockerBeeAcquisitionError();
  return Object.freeze({ daemonId: expected.daemonId, containerId, imageId, project: expected.profile.name, service: 'bee-uploader',
    networkMode, internalPort, publishedBindings: Object.freeze(bindings) });
}
