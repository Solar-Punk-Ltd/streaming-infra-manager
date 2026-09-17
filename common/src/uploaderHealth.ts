/**
 * What the manager made of a stream-uploader's own `/health`, in the one shape
 * the pages read.
 *
 * Shared because the manager writes it and the deployment page renders it, and
 * a second copy of the six states is exactly the kind of drift that leaves one
 * side rendering a state the other stopped sending.
 */

/** Nothing is wrong that the uploader can see. */
export const UPLOADER_HEALTH_OK = 'ok' as const;
/** The uploader is up and its boot has not finished, because its Bee node has not answered. */
export const UPLOADER_HEALTH_WAITING_FOR_NODE = 'waiting_for_node' as const;
/** A startup gate could not clear its node and the uploader started anyway. */
export const UPLOADER_HEALTH_WARNED = 'warned' as const;
/** The uploader is running and reporting something else wrong. */
export const UPLOADER_HEALTH_UNHEALTHY = 'unhealthy' as const;
/** Nothing this manager could read answered on the uploader's API port. */
export const UPLOADER_HEALTH_UNREACHABLE = 'unreachable' as const;
/** The deployment has no stream-uploader container, so there is nothing to ask. */
export const UPLOADER_HEALTH_NOT_DEPLOYED = 'not_deployed' as const;

export type UploaderHealthState =
  | typeof UPLOADER_HEALTH_OK
  | typeof UPLOADER_HEALTH_WAITING_FOR_NODE
  | typeof UPLOADER_HEALTH_WARNED
  | typeof UPLOADER_HEALTH_UNHEALTHY
  | typeof UPLOADER_HEALTH_UNREACHABLE
  | typeof UPLOADER_HEALTH_NOT_DEPLOYED;

/** The Bee node an uploader is waiting for, as the uploader reports it. */
export interface UploaderNodeWait {
  url: string;
  attempts: number;
  /** Absent until the first attempt has failed. */
  lastError?: string;
}

/**
 * A startup gate that warned instead of refusing.
 *
 * The gate's own message is deliberately absent: the uploader's `/health`
 * takes no credential and those messages carry node URLs and batch ids, so the
 * uploader does not put them there and the manager has none to pass on.
 */
export interface UploaderStartGateWarning {
  /** `ChequebookGate` or `PostageGate`. */
  gate: string;
  /** The ABR rung, absent on a single-node deployment. */
  rung?: string;
}

/**
 * One manager read of one uploader.
 *
 * `reasons` is the uploader's own list, passed through as written rather than
 * narrowed to a union here, so a rung of the stack this manager has not been
 * built against still reaches the page instead of being dropped.
 */
export interface UploaderHealthReading {
  state: UploaderHealthState;
  reasons: string[];
  /** ISO 8601, and only while the uploader is waiting for its node. */
  waitingSince?: string;
  node?: UploaderNodeWait;
  startGateWarnings?: UploaderStartGateWarning[];
}
