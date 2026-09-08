import type { StackContract } from '@streaming-infra-manager/common';
import { BUNDLED_PORT_TABLE } from '../../src/domain/versions/portTable.js';

/** A known port table for service tests that are not exercising contract discovery. */
export const ALLOCATION_CONTRACT: StackContract = {
  ports: [...BUNDLED_PORT_TABLE],
  maxSlot: 999,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: false, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: null, ome: null },
  warnings: [],
  allocationProblem: null,
};
