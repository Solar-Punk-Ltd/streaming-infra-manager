/** Public states the uploader records for one managed stream run. */
export type UploaderLifecycleState = 'ready' | 'claimed' | 'live' | 'waiting' | 'closed' | 'vod';

/** Active observations become unavailable without a validated refresh. */
export const UPLOADER_LIFECYCLE_STALE_AFTER_MS = 30_000;

/** A credential-free lifecycle fact the manager may send to an authenticated browser. */
export interface UploaderLifecycleStream {
  adminId: string;
  runNumber: number;
  state: UploaderLifecycleState;
  /** Age at manager receipt, measured only between uploader timestamps. */
  initialAgeMs: number;
}

/** One bounded manager read. An unavailable result never fabricates a live state. */
export type UploaderLifecycleReading =
  | { state: 'available'; streams: UploaderLifecycleStream[] }
  | { state: 'unavailable' };
