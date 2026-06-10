import { KIND_DEFAULT_SERVICES as SHARED_KIND_DEFAULT_SERVICES } from '@streaming-infra-manager/common';

import { ProfileKind, ProfileStatus, ServiceName } from './types.js';

export const PROFILE_KINDS = ['streamer', 'viewer', 'custom'] as const;

export const ALL_SERVICES = [
  'bee-uploader',
  'bee-gateway',
  'stream-uploader',
  'srs',
  'client',
] as const;

/** Default service set per profile kind (shared with the frontend via common). */
export const KIND_DEFAULT_SERVICES: Record<ProfileKind, readonly ServiceName[]> =
  SHARED_KIND_DEFAULT_SERVICES;

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
