import { OME_SERVICE, SRS_SERVICE } from './constants.js';

export const ENGINE_SERVICES = [SRS_SERVICE, OME_SERVICE] as const;
export type EngineName = (typeof ENGINE_SERVICES)[number];

export function engineForComponents(
  components?: readonly string[] | null,
): EngineName {
  return components?.includes(OME_SERVICE) ? OME_SERVICE : SRS_SERVICE;
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
