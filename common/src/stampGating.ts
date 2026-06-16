import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from './constants.js';

export const KIND_DEFAULT_SERVICES = {
  streamer: [SRS_SERVICE, STREAM_UPLOADER_SERVICE, BEE_UPLOADER_SERVICE],
  viewer: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
  custom: [],
} as const;

export interface StampGatedProfile {
  kind: string;
  components?: string[] | null;
  stamp_id?: string | null;
}

export function defaultServicesFor(profile: StampGatedProfile): string[] {
  if (profile.components && profile.components.length > 0) {
    return [...profile.components];
  }
  const defaults =
    KIND_DEFAULT_SERVICES[profile.kind as keyof typeof KIND_DEFAULT_SERVICES];
  return [...(defaults ?? [])];
}

export function servicesNeedStamp(services: readonly string[]): boolean {
  return services.includes(STREAM_UPLOADER_SERVICE);
}

export function hasStampId(profile: StampGatedProfile): boolean {
  return Boolean(profile.stamp_id && profile.stamp_id.trim());
}

export function isPendingStamp(profile: StampGatedProfile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) && !hasStampId(profile)
  );
}
