import { ProfileKind, ProfileStatus, ServiceName } from './types.js';

export const PROFILE_KINDS = ['streamer', 'viewer', 'custom'] as const;

export const ALL_SERVICES = [
  'bee-uploader',
  'bee-gateway',
  'stream-uploader',
  'srs',
  'client',
] as const;

/** Default service set per profile kind. Overridable per request. */
export const KIND_DEFAULT_SERVICES: Record<ProfileKind, readonly ServiceName[]> =
  {
    streamer: ['srs', 'stream-uploader', 'bee-uploader'],
    viewer: ['client', 'bee-gateway'],
    custom: [],
  };

export const PROFILE_STATUSES = [
  'DEPLOYING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'REMOVING',
  'ERROR',
] as const;

export const TRANSITIONAL_STATUSES: readonly ProfileStatus[] = [
  'DEPLOYING',
  'STOPPING',
  'REMOVING',
];
