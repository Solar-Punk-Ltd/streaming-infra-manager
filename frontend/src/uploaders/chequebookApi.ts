import type {
  ChequebookSummary,
} from '@streaming-infra-manager/common';

import { getJson } from '../http';

export function fetchChequebook(name: string): Promise<ChequebookSummary> {
  return getJson<ChequebookSummary>(
    `/profiles/${encodeURIComponent(name)}/chequebook`,
  );
}
