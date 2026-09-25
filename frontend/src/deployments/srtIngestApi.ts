import type { SrtIngestReading } from '@streaming-infra-manager/common';

import { getJson } from '../http';

/** What SRS's own statistics say about this deployment's SRT link over the last minute. */
export function fetchSrtIngest(
  name: string,
  signal?: AbortSignal,
): Promise<SrtIngestReading> {
  return getJson<SrtIngestReading>(
    `/profiles/${encodeURIComponent(name)}/srt-ingest`,
    { signal },
  );
}
