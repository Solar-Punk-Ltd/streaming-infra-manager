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

/**
 * A profile that is nothing but a Bee node — an ABR ladder rung, or any bare
 * publish target.
 *
 * It has no stream-uploader, so `servicesNeedStamp` says no; but it still owns a
 * wallet and buys its own postage batch, which is exactly what the uploader cards
 * manage. Without this such a profile would be invisible on the Uploaders tab and
 * there would be no way to fund it.
 */
export function isBeeNodeOnly(profile: StampGatedProfile): boolean {
  const services = defaultServicesFor(profile);
  return services.length === 1 && services[0] === BEE_UPLOADER_SERVICE;
}

/** Everything whose postage batch the Uploaders tab manages. */
export function managesOwnStamp(profile: StampGatedProfile): boolean {
  return servicesNeedStamp(defaultServicesFor(profile)) || isBeeNodeOnly(profile);
}

export function hasStampId(profile: StampGatedProfile): boolean {
  return Boolean(profile.stamp_id && profile.stamp_id.trim());
}

export function isPendingStamp(profile: StampGatedProfile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) && !hasStampId(profile)
  );
}
