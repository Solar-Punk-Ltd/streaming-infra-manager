/**
 * Parses the stream-uploader's own log lines into structured events. These lines are the most
 * direct truth of what the uploader did — which segments landed, whether a discontinuity was
 * armed, how many manifest publishes/retries occurred — and are the primary assertion source for
 * the upload-side scenarios (bee outage, crash recovery). Log format: `[ts] [LEVEL] - message`.
 */

export interface UploaderEvents {
  uploadedSegments: number[];
  discontinuitiesArmed: number[];
  manifestSocIndices: number[];
  staleWarnings: number;
  retries: number;
}

const RE_UPLOADED = /Segment (\d+) uploaded/g;
const RE_DISCONTINUITY = /Failed to upload segment (\d+)[^\n]*marking a discontinuity/g;
const RE_MANIFEST = /Manifest uploaded at SOC index (\d+)/g;
const RE_STALE = /is stale: \d+ consecutive/g;
const RE_RETRY = /Retrying in ~/g;
const RE_STREAM_ANNOUNCE = /Adding stream to list: (\{[^\n]*\})/g;

function captureNumbers(source: string, re: RegExp): number[] {
  return [...source.matchAll(re)].map((m) => Number(m[1]));
}

function countMatches(source: string, re: RegExp): number {
  return [...source.matchAll(re)].length;
}

export function parseUploaderLog(text: string): UploaderEvents {
  return {
    uploadedSegments: captureNumbers(text, RE_UPLOADED),
    discontinuitiesArmed: captureNumbers(text, RE_DISCONTINUITY),
    manifestSocIndices: captureNumbers(text, RE_MANIFEST),
    staleWarnings: countMatches(text, RE_STALE),
    retries: countMatches(text, RE_RETRY),
  };
}

/**
 * Topics the uploader announced as `live` in its own `Adding stream to list:` log lines, in order.
 * This is the authoritative, lag-free source of the stream's topic — unlike the gateway-served
 * catalog, which trails the uploader by minutes and can surface a stale topic from a prior stream.
 */
export function announcedLiveTopics(text: string): string[] {
  const topics: string[] = [];
  for (const match of text.matchAll(RE_STREAM_ANNOUNCE)) {
    try {
      const entry = JSON.parse(match[1]) as { topic?: string; state?: string };
      if (entry.state === 'live' && entry.topic) {
        topics.push(entry.topic);
      }
    } catch {
      // A log line whose JSON tail is truncated is not a usable announcement — skip it.
    }
  }
  return topics;
}

/** True if the sorted unique indices form a gapless run (max − min + 1 === unique count). */
export function isContiguous(indices: number[]): boolean {
  if (indices.length === 0) {
    return true;
  }
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  return unique[unique.length - 1] - unique[0] + 1 === unique.length;
}

/** Indices present in `after` but not in `before` — used to scope assertions to one test window. */
export function newIndices(before: number[], after: number[]): number[] {
  const seen = new Set(before);
  return after.filter((i) => !seen.has(i));
}
