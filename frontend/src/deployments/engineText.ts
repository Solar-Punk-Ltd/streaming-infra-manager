import {
  effectiveEngineSettings,
  type EngineName,
  type EngineSettings,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

/** What the engine is called on screen. */
export const ENGINE_LABEL: Record<EngineName, string> = {
  [SRS_SERVICE]: 'SRS 6',
  [OME_SERVICE]: 'OvenMediaEngine',
};

/**
 * The engine in one line, for the side column: what it is and the two numbers
 * that decide how far behind live a viewer ends up.
 *
 * It reads the effective values rather than the stored ones, so a deployment
 * that has never been tuned still says what it is running.
 */
export function engineSummary(
  engine: EngineName,
  settings: EngineSettings,
): string {
  const effective = effectiveEngineSettings(engine, settings);
  if (engine === OME_SERVICE) {
    return [
      ENGINE_LABEL[engine],
      `segment ${effective.HLS_SEGMENT_DURATION} s`,
      `playlist ${effective.HLS_SEGMENT_COUNT} pieces`,
    ].join(' · ');
  }
  return [
    'SRS',
    `segment ${effective.HLS_FRAGMENT} s`,
    `window ${effective.HLS_WINDOW} s`,
  ].join(' · ');
}
