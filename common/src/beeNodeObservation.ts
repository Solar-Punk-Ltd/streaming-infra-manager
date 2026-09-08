export type BeeNodeState = 'ready' | 'initializing' | 'unhealthy' | 'unreachable' | 'unknown';

/** Bee API probes only. This does not verify uploads, ingest or playback. */
export interface BeeNodeObservation {
  state: BeeNodeState;
  observedAt: string;
  healthStatus: 'ok' | 'nok' | null;
  readinessStatus: 'ready' | 'notReady' | null;
  version: string | null;
  apiVersion: string | null;
  chainProgress: { block: number; chainTip: number } | null;
}
