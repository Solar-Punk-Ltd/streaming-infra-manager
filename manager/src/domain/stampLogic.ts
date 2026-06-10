import { KIND_DEFAULT_SERVICES } from '../types/constants.js';
import { Profile } from '../types/index.js';

/**
 * Stamp gating logic, kept in one place so the orchestrator, the profile
 * service and the API serializer all agree on what "needs a stamp" means.
 *
 * The only service with a prerequisite is the stream-uploader: it needs a
 * usable postage stamp before it can upload. Everything else deploys freely.
 */

export const STREAM_UPLOADER_SERVICE = 'stream-uploader';

/** Services this profile deploys by default (explicit components or kind defaults). */
export function defaultServicesFor(profile: Profile): string[] {
  if (profile.components && profile.components.length > 0) {
    return [...profile.components];
  }
  return [...(KIND_DEFAULT_SERVICES[profile.kind] ?? [])];
}

/** A service set "needs a stamp" iff it includes the stream-uploader. */
export function servicesNeedStamp(services: readonly string[]): boolean {
  return services.includes(STREAM_UPLOADER_SERVICE);
}

/**
 * Phase 1 definition of "usable": the profile has a non-empty stamp_id. Phase 3
 * will additionally poll the bee node for real usability (TTL / funds).
 */
export function hasUsableStamp(profile: Profile): boolean {
  return Boolean(profile.stamp_id && profile.stamp_id.trim());
}

/**
 * Derived API field: the profile wants the uploader but has no usable stamp, so
 * the uploader is held back and surfaced as "Stamp required".
 */
export function isPendingStamp(profile: Profile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) && !hasUsableStamp(profile)
  );
}

export interface DeploySplit {
  /** Services to hand to deploy.sh now. */
  deploy: string[];
  /** Services deferred until a usable stamp exists. */
  heldBack: string[];
}

/**
 * Drop the stream-uploader from the deploy set when there is no usable stamp,
 * so the submodule's interactive STAMP guard never fires (it would EOF-abort
 * under the manager's stdin-less ScriptRunner).
 */
export function splitDeployableServices(
  profile: Profile,
  services: readonly string[],
): DeploySplit {
  if (hasUsableStamp(profile) || !servicesNeedStamp(services)) {
    return { deploy: [...services], heldBack: [] };
  }
  return {
    deploy: services.filter((service) => service !== STREAM_UPLOADER_SERVICE),
    heldBack: [STREAM_UPLOADER_SERVICE],
  };
}
