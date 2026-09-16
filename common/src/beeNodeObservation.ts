export type BeeNodeState =
  | 'ready'
  | 'initializing'
  | 'unhealthy'
  /** Nothing answered at the address at all. */
  | 'unreachable'
  /**
   * The node answered and its answer could not be read: headers arrived and
   * the body did not, or did not survive being read.
   *
   * Its own state because 'unreachable' and 'unknown' both send an operator to
   * look at the wrong thing. This one says the node is there.
   */
  | 'unreadable'
  | 'unknown';

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
