import type { Pool } from 'pg';
import { BEE_BRIDGE_CHECK_REVISION } from './beeBridgeCheck.js';
import { storedPassRecord, type BeeBridgeQualificationRecord, type BeeBridgeTuple } from './beeBridgeQualification.js';
import type { BeeBridgeCheckRecord, BeeBridgeQualificationStore } from './BeeBridgeQualificationStore.js';

const TUPLE_COLUMNS = 'image_id, engine_version, platform_os, platform_architecture, platform_variant, bridge_revision, harness_revision';
const tupleValues = (tuple: BeeBridgeTuple) => [tuple.imageId, tuple.engineVersion, tuple.platform.os, tuple.platform.architecture,
  tuple.platform.variant, tuple.bridgeRevision, BEE_BRIDGE_CHECK_REVISION];

export class PostgresBeeBridgeQualifications implements BeeBridgeQualificationStore {
  constructor(private readonly pool: Pool) {}

  async passFor(tuple: BeeBridgeTuple): Promise<BeeBridgeQualificationRecord | null> {
    const { rows } = await this.pool.query<{ id: string; evidence_digest: string }>(`SELECT id, evidence_digest FROM bee_bridge_qualifications
      WHERE outcome = 'passed' AND (${TUPLE_COLUMNS}) = ($1, $2, $3, $4, $5, $6, $7)`, tupleValues(tuple));
    const row = rows[0];
    return row ? storedPassRecord({ id: `stored-${row.id}`, tuple, harnessRevision: BEE_BRIDGE_CHECK_REVISION, evidenceDigest: row.evidence_digest }) : null;
  }

  async record(check: BeeBridgeCheckRecord): Promise<void> {
    await this.pool.query(`INSERT INTO bee_bridge_qualifications (${TUPLE_COLUMNS}, outcome, failed_check, evidence, evidence_digest, host_alias)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
      ON CONFLICT (${TUPLE_COLUMNS}) WHERE outcome = 'passed' DO NOTHING`,
    [...tupleValues(check.tuple), check.failedCheck === null ? 'passed' : 'failed', check.failedCheck,
      JSON.stringify(check.evidence.evidence), check.evidence.digest, check.hostAlias]);
  }
}
