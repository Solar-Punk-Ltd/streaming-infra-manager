import { isDeepStrictEqual } from 'node:util';
import { BEE_BRIDGE_CHECK_REVISION } from '../../src/domain/chequebook/beeBridgeCheck.js';
import { beeBridgeTuple, storedPassRecord, type BeeBridgeExecution, type BeeBridgeQualificationRecord, type BeeBridgeTuple } from '../../src/domain/chequebook/beeBridgeQualification.js';
import type { BeeBridgeCheckRecord, BeeBridgeQualificationStore } from '../../src/domain/chequebook/BeeBridgeQualificationStore.js';

const plain = (tuple: BeeBridgeTuple) => beeBridgeTuple(tuple as BeeBridgeExecution);

/** Mirrors the table's rule: one pass per tuple, every failure kept. Writes what it stored into the shared log, in order. */
export class InMemoryBeeBridgeQualifications implements BeeBridgeQualificationStore {
  readonly rows: (BeeBridgeCheckRecord & { readonly id: number })[] = [];
  constructor(private readonly log: string[] = []) {}

  async passFor(tuple: BeeBridgeTuple): Promise<BeeBridgeQualificationRecord | null> {
    const pass = this.storedPass(tuple);
    return pass ? storedPassRecord({ id: `stored-${pass.id}`, tuple: pass.tuple, harnessRevision: BEE_BRIDGE_CHECK_REVISION, evidenceDigest: pass.evidence.digest }) : null;
  }

  /** Checks and writes in one turn, as the unique index does, so racing passes cannot both land. */
  async record(check: BeeBridgeCheckRecord): Promise<void> {
    if (check.failedCheck === null && this.storedPass(check.tuple)) return;
    this.rows.push({ ...structuredClone(check), id: this.rows.length + 1 });
    this.log.push(check.failedCheck === null ? 'pass stored' : `failure stored ${check.failedCheck}`);
  }

  private storedPass(tuple: BeeBridgeTuple) {
    return this.rows.find(row => row.failedCheck === null && isDeepStrictEqual(plain(row.tuple), plain(tuple)));
  }
}
