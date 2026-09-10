import type { Pool } from 'pg';
import type { NewChequebookOperation } from '../../src/domain/chequebook/ChequebookOperationRepository.js';
import { PostgresChequebookOperationRepository } from '../../src/domain/chequebook/PostgresChequebookOperationRepository.js';
import { PostgresChequebookTargetOwnership } from '../../src/domain/chequebook/PostgresChequebookTargetOwnership.js';

export async function seedSyntheticChequebookTarget(pool: Pool, profileName: string): Promise<void> {
  await pool.query("UPDATE profiles SET status='RUNNING', components=ARRAY['bee-uploader'] WHERE name=$1", [profileName]);
  await pool.query(`INSERT INTO deploy_targets (alias,daemon_id,verified_at) VALUES ('localhost','synthetic-daemon','2026-09-09T01:02:03.123456Z') ON CONFLICT DO NOTHING`);
  await pool.query("INSERT INTO reservation_daemon_inventory (daemon_id) VALUES ('synthetic-daemon') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO port_reservations (daemon_id,protocol,port,profile_name,service,port_var,state,held_services)
    SELECT 'synthetic-daemon','tcp',10005+port_slot*10,name,'bee-uploader','BEE_UPLOADER_API_PORT','active',ARRAY['bee-uploader']
    FROM profiles WHERE name=$1`, [profileName]);
}

/** Journal tests inject a synthetic SQL owner. Production preparation must acquire its own target and connection. */
export class SyntheticTargetChequebookRepository extends PostgresChequebookOperationRepository {
  constructor(private readonly fixturePool: Pool, options: { receiptPollBudgetMs?: number } = {}) { super(fixturePool, options); }
  override async admit(candidate: NewChequebookOperation) {
    if (candidate.submissionTarget || await this.findByRequestId(candidate.requestId)) return super.admit(candidate);
    const submissionTarget = await new PostgresChequebookTargetOwnership(this.fixturePool).capture(candidate.profileName, candidate.profileInstanceId);
    return super.admit({ ...candidate, submissionTarget });
  }
}
