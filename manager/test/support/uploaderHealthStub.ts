import type { UploaderHealthReading } from '@streaming-infra-manager/common';

import type { UploaderHealthService } from '../../src/domain/UploaderHealthService.js';

/**
 * The uploader health reader for a profiles-router test that is about one of
 * the other routes.
 *
 * Type-only imports, so this module pulls nothing in at runtime and a test that
 * has to load the router dynamically can still import it at the top.
 */
export function uploaderHealthStub(
  reading: UploaderHealthReading = { state: 'not_deployed', reasons: [] },
): UploaderHealthService {
  return {
    async read(): Promise<UploaderHealthReading> {
      return reading;
    },
  } as unknown as UploaderHealthService;
}
