/**
 * How the SRT link from a broadcaster into SRS is holding up, in the one shape
 * the manager answers and the deployment page renders.
 *
 * SRS prints a statistics line for each SRT publisher about every ten seconds,
 * counting that interval only, and its HTTP API does not expose the same
 * counters (SRS issue 4554). So the manager reads those lines out of the
 * engine's log and passes on numbers and a verdict, never the log: SRS writes
 * its webhook URL, with the uploader's token in it, and the publisher's address
 * into the same log.
 *
 * Shared because the manager writes the reading and the page renders it, and a
 * verdict worked out on both sides is two verdicts that can drift apart.
 */

/** The packets SRS counted over the window, summed over every report in it. */
export interface SrtLinkCounts {
  /** Data packets that arrived, libsrt's `pktRecv`. */
  received: number;
  /** Packets SRT noticed were missing, `pktRcvLoss`. */
  lost: number;
  /** Packets that arrived on a second try, `pktRcvRetrans`. */
  retransmitted: number;
  /** Packets SRT stopped waiting for and never delivered, `pktRcvDrop`. These are the holes in the picture. */
  dropped: number;
}

/** Each count as a percentage of `received`, or null when nothing was received. */
export interface SrtLinkPercentages {
  lost: number | null;
  retransmitted: number | null;
  dropped: number | null;
}

/** Nothing was dropped. Loss that a retransmission recovered in time never reached the picture. */
export const SRT_LINK_HEALTHY = 'healthy' as const;
/** Some packets were dropped, fewer than the bad line. */
export const SRT_LINK_DEGRADED = 'degraded' as const;
/** Dropped packets reached the bad line. */
export const SRT_LINK_BAD = 'bad' as const;

export type SrtLinkVerdict =
  | typeof SRT_LINK_HEALTHY
  | typeof SRT_LINK_DEGRADED
  | typeof SRT_LINK_BAD;

/** The share of dropped packets, against those received, at and above which a link is bad. */
export const SRT_BAD_DROP_PERCENT = 1;

/** SRS printed at least one report in the window, and the reading carries its numbers. */
export const SRT_INGEST_MEASURED = 'measured' as const;
/** SRS is running and printed no report in the window. */
export const SRT_INGEST_NO_REPORTS = 'no_reports' as const;
/** No SRS container is running for the deployment, so there is no link to read. */
export const SRT_INGEST_NOT_RUNNING = 'not_running' as const;
/** The engine's log could not be read. Says nothing about the link. */
export const SRT_INGEST_UNREADABLE = 'unreadable' as const;
/** The deployment's media server is not SRS, so there is no such log. */
export const SRT_INGEST_NOT_SRS = 'not_srs' as const;

export type SrtIngestUnmeasuredState =
  | typeof SRT_INGEST_NO_REPORTS
  | typeof SRT_INGEST_NOT_RUNNING
  | typeof SRT_INGEST_UNREADABLE
  | typeof SRT_INGEST_NOT_SRS;

export interface SrtIngestMeasured {
  state: typeof SRT_INGEST_MEASURED;
  /** How far back the manager read the log. */
  windowSeconds: number;
  /** How many statistics lines the counts are summed from. */
  reports: number;
  /** How many SRT connections printed them. A publisher that reconnected counts twice. */
  connections: number;
  counts: SrtLinkCounts;
  percent: SrtLinkPercentages;
  verdict: SrtLinkVerdict;
}

export interface SrtIngestUnmeasured {
  state: SrtIngestUnmeasuredState;
  windowSeconds: number;
}

/** One manager read of one deployment's SRT ingest. */
export type SrtIngestReading = SrtIngestMeasured | SrtIngestUnmeasured;

export function srtLinkVerdict(counts: SrtLinkCounts): SrtLinkVerdict {
  if (counts.dropped === 0) return SRT_LINK_HEALTHY;
  // Multiplied rather than divided, so exactly one percent is bad however a
  // quotient would round, and a link that dropped packets while receiving none
  // is bad rather than a division by zero.
  if (counts.dropped * 100 >= counts.received * SRT_BAD_DROP_PERCENT) {
    return SRT_LINK_BAD;
  }
  return SRT_LINK_DEGRADED;
}

export function srtLinkPercentages(counts: SrtLinkCounts): SrtLinkPercentages {
  const shareOfReceived = (part: number): number | null =>
    counts.received > 0 ? (part * 100) / counts.received : null;
  return {
    lost: shareOfReceived(counts.lost),
    retransmitted: shareOfReceived(counts.retransmitted),
    dropped: shareOfReceived(counts.dropped),
  };
}

export interface SrtIngestMeasurement {
  windowSeconds: number;
  reports: number;
  connections: number;
  counts: SrtLinkCounts;
}

/** A measured reading, with the shares and the verdict worked out from its counts. */
export function measuredSrtIngest(
  measurement: SrtIngestMeasurement,
): SrtIngestMeasured {
  return {
    state: SRT_INGEST_MEASURED,
    ...measurement,
    percent: srtLinkPercentages(measurement.counts),
    verdict: srtLinkVerdict(measurement.counts),
  };
}
