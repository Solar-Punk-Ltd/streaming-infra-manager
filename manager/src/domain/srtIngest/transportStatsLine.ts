import type { SrtLinkCounts } from '@streaming-infra-manager/common';

/**
 * SRS's per-publisher SRT statistics line, and nothing else from its log.
 *
 * SRS prints one for each SRT publisher about every ten seconds. It clears
 * libsrt's counters as it reads them, so each line counts its own interval:
 *
 *   [2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397
 *
 * The bracket before the message is SRS's id for the connection. The same log
 * carries the webhook URL with the uploader's token in it and the publisher's
 * address, so a line is either exactly this shape, anchored at both ends, or it
 * is not read at all, and what comes out is four counts and the connection id.
 */

/** Text every publisher statistics line contains, for a reader to filter on before parsing. */
export const TRANSPORT_STATS_MARKER = '<- SRT_CPB Transport Stats # ';

/** One statistics line: one SRT connection's counts over one interval. */
export interface TransportStatsReport {
  /** SRS's id for the connection, used only to tell connections apart. It never leaves the manager. */
  connection: string;
  counts: SrtLinkCounts;
}

/** A colour or cursor sequence, which SRS writes around the lines it prints to a console. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `[time][level][pid][connection] `, the prefix SRS puts before every message. */
const SRS_LINE_PREFIX = String.raw`\[[^\]]*\]\[[A-Za-z]+\]\[\d+\]\[([A-Za-z0-9]{1,64})\] `;

/** No more digits than a JavaScript number holds exactly. */
const COUNT = String.raw`(\d{1,15})`;

const REPORT_LINE = new RegExp(
  `^${SRS_LINE_PREFIX}<- SRT_CPB Transport Stats # ` +
    `pktRecv=${COUNT}, pktRcvLoss=${COUNT}, pktRcvRetrans=${COUNT}, pktRcvDrop=${COUNT}$`,
);

export function parseTransportStatsLine(line: string): TransportStatsReport | null {
  const match = REPORT_LINE.exec(line.replace(ANSI_ESCAPE, '').trimEnd());
  if (!match) return null;
  const [, connection, received, lost, retransmitted, dropped] = match;
  return {
    connection,
    counts: {
      received: Number(received),
      lost: Number(lost),
      retransmitted: Number(retransmitted),
      dropped: Number(dropped),
    },
  };
}

/** Every statistics line among `lines`, in order. Any other line is skipped without a trace. */
export function parseTransportStatsLines(
  lines: readonly string[],
): TransportStatsReport[] {
  return lines.flatMap((line) => {
    const report = parseTransportStatsLine(line);
    return report ? [report] : [];
  });
}
