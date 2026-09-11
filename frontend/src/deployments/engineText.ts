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

/**
 * The engine in one line, for the side column: what it is and the two numbers
 * that decide how far behind live a viewer ends up.
 *
 * Configured values and uncertainty come from the same observations as the
 * engine card and settings drawer. These are not live engine measurements.
 */
export function engineSummary(
  engine: EngineName,
  observations: EngineSettingObservations,
): string {
  const setting = (key: string, unit: string): string => {
    const observation = observations[key];
    const { value } = engineObservationText(observation, unit);
    return observation?.status === 'known' ? value : value.toLowerCase();
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
