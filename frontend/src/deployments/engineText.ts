import {
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

/** What the line says for a key the deployment's own config file dropped. */
const NOT_IN_FILE = 'not in the file';

/**
 * The engine in one line, for the side column: what it is and the two numbers
 * that decide how far behind live a viewer ends up.
 *
 * It reads what the manager says the engine runs with, the same map the
 * engine card and the settings drawer read, so every card on the page names
 * the same numbers. A key the deployment's own config file dropped is said to
 * be missing rather than filled with a number nothing reads.
 */
export function engineSummary(
  engine: EngineName,
  effective: EngineSettings,
): string {
  const setting = (key: string, unit: string): string => {
    const value = effective[key];
    return value === undefined ? NOT_IN_FILE : `${value} ${unit}`;
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
