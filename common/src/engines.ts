import { OME_SERVICE, SRS_SERVICE } from './constants.js';

export const ENGINE_SERVICES = [SRS_SERVICE, OME_SERVICE] as const;
export type EngineName = (typeof ENGINE_SERVICES)[number];

export function engineForComponents(
  components?: readonly string[] | null,
): EngineName {
  return components?.includes(OME_SERVICE) ? OME_SERVICE : SRS_SERVICE;
}

/**
 * The media server in a service list, or null when there is none.
 *
 * Different question from `engineForComponents`, which answers "which engine
 * plugin does the uploader load" and defaults to SRS because the uploader
 * always needs one. A viewer runs no media server at all, and anything that
 * offers to configure or restart one has to be able to say so.
 */
export function engineOfServices(
  services?: readonly string[] | null,
): EngineName | null {
  return ENGINE_SERVICES.find((engine) => services?.includes(engine)) ?? null;
}

export function hasConflictingEngines(
  components?: readonly string[] | null,
): boolean {
  return (
    !!components &&
    components.includes(SRS_SERVICE) &&
    components.includes(OME_SERVICE)
  );
}
