import {
  ABR_UPLOADER_KIND,
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  defaultServicesFor,
  isBeeNodeOnly,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';

/**
 * What a deployment is, in the words the operator uses.
 *
 * Read from the services it runs rather than from `kind`, because `kind` is a
 * creation-time label: a `custom` that happens to run an engine and an uploader
 * is a stream in every way that matters on screen, and a `streamer` whose
 * components were narrowed is not.
 */
export type DeploymentShape =
  | 'stream'
  | 'viewer'
  | 'bee-node'
  | 'abr-uploader'
  | 'custom';

export const SHAPE_LABEL: Record<DeploymentShape, string> = {
  stream: 'Stream',
  viewer: 'Viewer',
  'bee-node': 'Bee node',
  'abr-uploader': 'ABR uploader',
  custom: 'Custom',
};

export const SERVICE_DESCRIPTIONS: Record<string, string> = {
  [SRS_SERVICE]: 'media server (SRT ingest)',
  [OME_SERVICE]: 'media server (OvenMediaEngine)',
  [STREAM_UPLOADER_SERVICE]: 'uploads segments to Swarm',
  [BEE_UPLOADER_SERVICE]: 'own Bee node',
  [CLIENT_SERVICE]: 'web player',
  [BEE_GATEWAY_SERVICE]: 'Swarm gateway for the player',
};

const ENGINES: readonly string[] = [SRS_SERVICE, OME_SERVICE];

export function servicesOf(profile: Profile): string[] {
  return defaultServicesFor(profile);
}

export function hasService(profile: Profile, service: string): boolean {
  return servicesOf(profile).includes(service);
}

export function engineOf(profile: Profile): string | null {
  return servicesOf(profile).find((s) => ENGINES.includes(s)) ?? null;
}

export function shapeOf(profile: Profile): DeploymentShape {
  // Before the stream test: an ABR uploader runs an engine and an uploader too,
  // and it is the pool behind it, not its own node, that decides what it needs.
  if (profile.kind === ABR_UPLOADER_KIND) return 'abr-uploader';

  const services = servicesOf(profile);
  if (
    services.includes(STREAM_UPLOADER_SERVICE) &&
    services.some((s) => ENGINES.includes(s))
  ) {
    return 'stream';
  }
  if (services.includes(CLIENT_SERVICE)) return 'viewer';
  if (isBeeNodeOnly(profile)) return 'bee-node';
  return 'custom';
}

/** Everything on this manager that signs a feed, so a viewer can follow it. */
export function streamersOf(profiles: Profile[]): Profile[] {
  return profiles.filter(
    (profile) =>
      Boolean(profile.public_key) &&
      ['stream', 'abr-uploader'].includes(shapeOf(profile)),
  );
}

const TRANSITIONAL_STATUSES: readonly string[] = [
  'DEPLOYING',
  'STOPPING',
  'REMOVING',
];

export function isRunning(profile: Profile): boolean {
  return profile.status === 'RUNNING';
}

export function isTransitional(profile: Profile): boolean {
  return TRANSITIONAL_STATUSES.includes(profile.status);
}

interface StatusLabel {
  label: string;
  tone: 'ok' | 'warn' | 'err' | 'info' | 'gray';
}

const STATUS_LABELS: Record<string, StatusLabel> = {
  RUNNING: { label: 'Running', tone: 'ok' },
  DEPLOYING: { label: 'Deploying', tone: 'info' },
  STOPPING: { label: 'Stopping', tone: 'warn' },
  STOPPED: { label: 'Stopped', tone: 'gray' },
  REMOVING: { label: 'Removing', tone: 'warn' },
  ERROR: { label: 'Error', tone: 'err' },
};

export function statusLabelOf(profile: Profile): StatusLabel {
  return STATUS_LABELS[profile.status] ?? { label: profile.status, tone: 'gray' };
}
