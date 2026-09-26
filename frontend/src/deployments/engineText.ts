import {
  type EngineName,
  type EngineSettingObservations,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';
import { engineObservationText } from './engineObservationText';

/** What the engine is called on screen. */
export const ENGINE_LABEL: Record<EngineName, string> = {
  [SRS_SERVICE]: 'SRS 6',
  [OME_SERVICE]: 'OvenMediaEngine',
};

/** Said wherever the page is about to recreate the engine, which drops the connection a publisher streams in over. */
export const LIVE_PUBLISHER_DISCONNECTED = 'A publisher, if one is live, is disconnected for a few seconds.';

/**
 * Said beside an engine value the running containers are behind on. The
 * Engine card and the side column read the stored settings, so between a
 * save and Apply they name a value the engine does not run yet.
 */
export const SAVED_NOT_APPLIED = 'saved, not applied';

/**
 * The engine in one line, for the side column: what it is and the two numbers
 * that decide how far behind live a viewer ends up.
 *
 * Configured values and uncertainty come from the same observations as the
 * Engine card's list. These are not live engine measurements, and a value
 * the running containers are behind on is marked, as that list marks it.
 */
export function engineSummary(
  engine: EngineName,
  observations: EngineSettingObservations,
  /** The keys whose saved value the running containers do not have yet, from the deployment's settings list. */
  savedNotApplied: readonly string[] = [],
): string {
  const setting = (key: string, unit: string): string => {
    const observation = observations[key];
    const { value } = engineObservationText(observation, unit);
    const shown = observation?.status === 'known' ? value : value.toLowerCase();
    return savedNotApplied.includes(key) ? `${shown} (${SAVED_NOT_APPLIED})` : shown;
  };
  if (engine === OME_SERVICE) {
    return [
      ENGINE_LABEL[engine],
      `segment ${setting('HLS_SEGMENT_DURATION', 's')}`,
      `playlist ${setting('HLS_SEGMENT_COUNT', 'pieces')}`,
    ].join(' · ');
  }
  return [
    'SRS',
    `segment ${setting('HLS_FRAGMENT', 's')}`,
    `window ${setting('HLS_WINDOW', 's')}`,
  ].join(' · ');
}
