import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  KIND_DEFAULT_SERVICES as SHARED_KIND_DEFAULT_SERVICES,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { ProfileKind, ProfileStatus, ServiceName } from './types.js';

export const PROFILE_KINDS = [
  'streamer',
  'viewer',
  'custom',
  'abr-uploader',
] as const;

export const ALL_SERVICES = [
  BEE_UPLOADER_SERVICE,
  BEE_GATEWAY_SERVICE,
  STREAM_UPLOADER_SERVICE,
  SRS_SERVICE,
  OME_SERVICE,
  CLIENT_SERVICE,
] as const;

/** Default service set per profile kind. Overridable per request. */
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
