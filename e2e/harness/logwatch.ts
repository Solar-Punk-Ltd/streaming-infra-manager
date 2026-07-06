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
