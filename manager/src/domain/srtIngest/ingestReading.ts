import {
  measuredSrtIngest,
  SRT_INGEST_NO_REPORTS,
  type SrtIngestReading,
  type SrtLinkCounts,
} from '@streaming-infra-manager/common';

import type { TransportStatsReport } from './transportStatsLine.js';

const NO_PACKETS: SrtLinkCounts = { received: 0, lost: 0, retransmitted: 0, dropped: 0 };

/**
 * One reading from every report in the window, summed across all of them.
 *
 * Summed across connections as well, because a publisher that dropped out and
 * came back is still the one link this deployment takes in. The connections
 * are counted here and their ids go no further.
 */
export function ingestReadingFrom(
  reports: readonly TransportStatsReport[],
  windowSeconds: number,
): SrtIngestReading {
  if (reports.length === 0) return { state: SRT_INGEST_NO_REPORTS, windowSeconds };
  return measuredSrtIngest({
    windowSeconds,
    reports: reports.length,
    connections: new Set(reports.map((report) => report.connection)).size,
    counts: reports.reduce((sum, report) => addCounts(sum, report.counts), NO_PACKETS),
  });
}

function addCounts(a: SrtLinkCounts, b: SrtLinkCounts): SrtLinkCounts {
  return {
    received: a.received + b.received,
    lost: a.lost + b.lost,
    retransmitted: a.retransmitted + b.retransmitted,
    dropped: a.dropped + b.dropped,
  };
}
