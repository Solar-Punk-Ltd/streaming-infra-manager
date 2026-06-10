/**
 * Stamp gating shared by the manager and the frontend so both derive the same
 * answer to "does this profile need a postage stamp, and does it have one".
 * Only the stream-uploader has that prerequisite.
 */

export const STREAM_UPLOADER_SERVICE = 'stream-uploader';

export const KIND_DEFAULT_SERVICES = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  viewer: ['client', 'bee-gateway'],
  custom: [],
} as const;

/** The minimal profile shape the gating rules read. */
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
 * "Usable" here only means a non-empty stamp_id. On-node validity (exists,
 * not expired) is verified against the bee node when the uploader is actually
 * deployed — see the manager's StampService.assertStampUsable.
 */
export function hasUsableStamp(profile: StampGatedProfile): boolean {
  return Boolean(profile.stamp_id && profile.stamp_id.trim());
}

/** The profile wants the uploader but has no stamp yet ("Stamp required"). */
export function isPendingStamp(profile: StampGatedProfile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) && !hasUsableStamp(profile)
  );
}
