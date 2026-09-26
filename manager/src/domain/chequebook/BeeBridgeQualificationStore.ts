import type { BeeBridgeCheck } from '@streaming-infra-manager/common';
import type { BeeBridgeCheckEvidence } from './beeBridgeCheck.js';
import type { BeeBridgeQualificationRecord, BeeBridgeTuple } from './beeBridgeQualification.js';

/** One check the manager ran in a Bee container, as it is stored. */
export interface BeeBridgeCheckRecord {
  readonly tuple: BeeBridgeTuple;
  /** Null for a pass. */
  readonly failedCheck: BeeBridgeCheck | null;
  readonly evidence: BeeBridgeCheckEvidence;
  /** The deploy target alias the tuple was checked on. */
  readonly hostAlias: string;
}

/** The manager's own record of the Bee images it checked, beside the seed catalog. */
export interface BeeBridgeQualificationStore {
  /** The pass the current check stored for exactly this tuple, as a record the qualifier reads, or null. */
  passFor(tuple: BeeBridgeTuple): Promise<BeeBridgeQualificationRecord | null>;
  /** Stores one check. A pass for a tuple that already has one leaves the first in place, and every failure is kept. */
  record(check: BeeBridgeCheckRecord): Promise<void>;
}
