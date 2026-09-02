import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from './constants.js';

export const KIND_DEFAULT_SERVICES = {
  streamer: [SRS_SERVICE, STREAM_UPLOADER_SERVICE, BEE_UPLOADER_SERVICE],
  /**
   * Publishes to an ABR node pool, so it runs no Bee node of its own: the pool's
   * rungs are the publish targets and they hold the postage. Dropping
   * `bee-uploader` is also what lets an explicit `BEE_URL` survive — deploy.sh
   * overwrites it whenever a local bee-uploader is enabled.
   */
  'abr-uploader': [SRS_SERVICE, STREAM_UPLOADER_SERVICE],
  viewer: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
  custom: [],
} as const;

export interface StampGatedProfile {
  kind: string;
  components?: string[] | null;
  stamp_id?: string | null;
  /**
   * A pasted BEE_PUBLISHERS: the uploader publishes to an ABR node pool, one Bee
   * node per rung, instead of to its own node. See usesNodePool.
   */
  bee_publishers?: string | null;
}

export const ABR_UPLOADER_KIND = 'abr-uploader';

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

/**
 * Everything whose postage batch the Uploaders tab manages.
 *
 * A pool-backed uploader is excluded: its batches are bought per rung on the
 * pool's own card, it has no Bee node of its own, and rendering it here would
 * give it a funding panel pointed at a node that does not exist.
 */
export function managesOwnStamp(profile: StampGatedProfile): boolean {
  if (usesNodePool(profile)) return false;
  return servicesNeedStamp(defaultServicesFor(profile)) || isBeeNodeOnly(profile);
}

export function hasStampId(profile: StampGatedProfile): boolean {
  return Boolean(profile.stamp_id && profile.stamp_id.trim());
}

export function hasBeePublishers(profile: StampGatedProfile): boolean {
  return Boolean(profile.bee_publishers && profile.bee_publishers.trim());
}

/**
 * An uploader that publishes to an ABR node pool.
 *
 * Its postage is the pool's — one batch per rung, bought over there, possibly
 * under a different manager — so this profile's own `stamp_id` is not what gates
 * it. `BEE_PUBLISHERS` set is what the uploader starts on; `STAMP` is ignored
 * while it is.
 */
export function usesNodePool(profile: StampGatedProfile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) && hasBeePublishers(profile)
  );
}

export function isPendingStamp(profile: StampGatedProfile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) &&
    !hasStampId(profile) &&
    !hasBeePublishers(profile)
  );
}
