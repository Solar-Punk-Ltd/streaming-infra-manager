/** Public states the uploader records for one managed stream run. */
export type UploaderLifecycleState = 'ready' | 'claimed' | 'live' | 'waiting' | 'closed' | 'vod';

/** Validated terminal outcomes the manager may explain to an operator. */
export type UploaderLifecycleCloseReason =
  | 'reconnect_timeout'
  | 'cancelled'
  | 'recovery_required'
  | 'finalization_failed'
  | 'empty';

/** Active observations become unavailable without a validated refresh. */
export const UPLOADER_LIFECYCLE_STALE_AFTER_MS = 30_000;

/** The negotiated SRS reconnect window. */
export const UPLOADER_RECONNECT_WINDOW_MS = 60_000;

/** A credential-free lifecycle fact the manager may send to an authenticated browser. */
export interface UploaderLifecycleStream {
  adminId: string;
  runNumber: number;
  state: UploaderLifecycleState;
  /** Age at manager receipt, measured only between uploader timestamps. */
  initialAgeMs: number;
  /** Time left at manager receipt, measured only between uploader timestamps. */
  deadlineRemainingMs?: number;
  closeReason?: UploaderLifecycleCloseReason;
}

/** One bounded manager read. An unavailable result never fabricates a live state. */
export type UploaderLifecycleReading =
  | { state: 'available'; streams: UploaderLifecycleStream[] }
  | { state: 'unavailable' };
