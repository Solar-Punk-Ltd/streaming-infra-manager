import type { UploaderHealthReading } from '@streaming-infra-manager/common';

import { getJson } from '../http';

/** What this deployment's own stream-uploader says about itself, the manager's read of it. */
export function fetchUploaderHealth(
  name: string,
  signal?: AbortSignal,
): Promise<UploaderHealthReading> {
  return getJson<UploaderHealthReading>(
    `/profiles/${encodeURIComponent(name)}/uploader-health`,
    { signal },
  );
}
