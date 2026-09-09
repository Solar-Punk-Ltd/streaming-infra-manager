import {
  type EngineSettings,
  nullify,
  type StackPortVar,
} from '@streaming-infra-manager/common';
import { Pool } from 'pg';

import { Profile, ProfileKind, ProfileStatus } from '../types/index.js';
import { reserveSlotFor } from './ports/reservationSql.js';
import { DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL, OPERATION_HOLD_FOR_OWNER_SQL, PROFILE_COLUMNS, PROFILE_SLOT_LOCK_KEY } from './profileSql.js';
import { ProfileConfigError } from './errors/index.js';
import type { StackSecrets } from './versions/stackSecrets.js';
import type { ExpectedDeployOwner } from './versions/buildLedger.js';

export interface ProfileWriteData {
  notes?: string | null;
  components?: string[] | null;
  host?: string | null;
  feed_owner?: string | null;
  feed_topic?: string | null;
  private_key?: string | null;
  public_key?: string | null;
  stamp_id?: string | null;
  bee_publishers?: string | null;
  bee_url?: string | null;
  srt_passphrase?: string | null;
  group_id?: number | null;
}

export interface EngineOverviewSnapshot {
  profile: Profile;
  engineConfig: string | null;
}

export interface EngineSettingsWriteOwner extends ExpectedDeployOwner {
  jobReferenceId: number;
}

/** Where a new deployment goes: which stack version it runs, and how high its port slot may be. */
export interface NewProfilePlacement {
  stackVersionId: number;
  /** The highest slot a deployment of the version may get: its own maximum, never above the manager's. */
  slotCap: number;
  /** The daemon the deployment's ports belong to, from `docker info`. */
  daemonId: string;
  /** The version's port table, every port of which the slot reserves. */
  table: readonly StackPortVar[];
}

export type ProfileRemovalClaim = Pick<Profile, 'name' | 'instance_id' | 'intent_revision'>;

export class ProfileRepository {
  constructor(private readonly pool: Pool) {}

  async claimRemoval(name: string, expectedInstanceId: string): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles SET status = 'REMOVING', intent_revision = intent_revision + 1,
         last_error = NULL, last_error_at = NULL, updated_at = NOW()
       WHERE name = $1 AND instance_id = $2 AND status IN ('RUNNING', 'STOPPED', 'ERROR')
       RETURNING ${PROFILE_COLUMNS}`, [name, expectedInstanceId],
    );
    return result.rows[0] ?? null;
  }

  async failRemoval(claim: ProfileRemovalClaim, message: string): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles SET status = 'ERROR', last_error = $4, last_error_at = NOW(), updated_at = NOW()
       WHERE name = $1 AND instance_id = $2 AND intent_revision = $3 AND status = 'REMOVING'
       RETURNING ${PROFILE_COLUMNS}`, [claim.name, claim.instance_id, claim.intent_revision, message],
    );
    return result.rows[0] ?? null;
  }

  async completeRemoval(claim: ProfileRemovalClaim, cleanFiles: () => Promise<void>): Promise<{ port_slot: number } | null> {
    return this.deleteProfile(claim.name, claim, cleanFiles);
  }

  /** One statement keeps revision identity, settings and the config in the same database snapshot. */
  async engineOverviewSnapshot(name: string): Promise<EngineOverviewSnapshot | null> {
    const result = await this.pool.query<Profile & { engine_config: string | null }>(
      `SELECT ${PROFILE_COLUMNS}, engine_config FROM profiles WHERE name = $1`, [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { engine_config, ...profile } = row;
    return { profile, engineConfig: engine_config };
  }

  async findByName(name: string): Promise<Profile | null> {
    const r = await this.pool.query<Profile>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = $1`,
      [name],
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
  }

  async list(): Promise<Profile[]> {
    const result = await this.pool.query<Profile>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles ORDER BY port_slot ASC`,
    );
    return result.rows;
  }

  async insertWithFreeSlot(
    name: string,
    kind: ProfileKind,
    status: ProfileStatus,
    data: ProfileWriteData,
    placement: NewProfilePlacement,
  ): Promise<Profile | null> {
    const dataWithNullFields = nullify(data);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        PROFILE_SLOT_LOCK_KEY,
      ]);
      // The slot and its reservations, in this transaction, so a deployment
      // record and the ports it will bind appear together or not at all.
      const slot = await reserveSlotFor(client, name, placement);
      if (slot === null) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query<Profile>(
        `INSERT INTO profiles (
           name, port_slot, kind, notes, status,
           components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
           srt_passphrase, group_id, bee_publishers, bee_url, stack_version_id, deployment_phase
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 CASE WHEN $5 = 'DEPLOYING' THEN 'starting' ELSE NULL END)
         RETURNING ${PROFILE_COLUMNS}`,
        [
          name,
          slot,
          kind,
          dataWithNullFields.notes,
          status,
          dataWithNullFields.components,
          dataWithNullFields.host,
          dataWithNullFields.feed_owner,
          dataWithNullFields.feed_topic,
          dataWithNullFields.private_key,
          dataWithNullFields.public_key,
          dataWithNullFields.stamp_id,
          dataWithNullFields.srt_passphrase,
          dataWithNullFields.group_id,
          dataWithNullFields.bee_publishers,
          dataWithNullFields.bee_url,
          placement.stackVersionId,
        ],
      );
      await client.query('COMMIT');
      return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * @param engineSettings replaces the column in the same statement, for a
   *   caller whose edit changes what the stored settings mean. Left out, the
   *   column keeps what it holds, which is what every ordinary PUT body wants.
   */
  async updateEditable(
    name: string,
    kind: ProfileKind,
    dataWithOptionalValues: ProfileWriteData = {},
    engineSettings?: EngineSettings,
  ): Promise<Profile | null> {
    const data = nullify(dataWithOptionalValues);
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET kind = $2,
             notes = $3,
             components = $4,
             feed_owner = $5,
             feed_topic = $6,
             private_key = $7,
             public_key = $8,
             stamp_id = $9,
             bee_publishers = $10,
             bee_url = $11,
             srt_passphrase = $12,
             engine_settings = COALESCE($13::jsonb, engine_settings),
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [
        name,
        kind,
        data.notes,
        data.components,
        data.feed_owner,
        data.feed_topic,
        data.private_key,
        data.public_key,
        data.stamp_id,
        data.bee_publishers,
        data.bee_url,
        data.srt_passphrase,
        engineSettings === undefined ? null : JSON.stringify(engineSettings),
      ],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  /**
   * Replaces the whole engine settings object.
   *
   * Deliberately not part of `ProfileWriteData`, which `updateEditable` writes
   * from a full-replace PUT body: a body that has never heard of engine
   * settings would clear them, and every existing caller of that path is such
   * a body. The settings have their own route and their own write, the way the
   * stamp id does.
   */
  async updateEngineSettings(
    name: string,
    settings: EngineSettings,
    owner: EngineSettingsWriteOwner,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET engine_settings = $2::jsonb,
             updated_at = NOW()
       WHERE name = $1 AND instance_id = $3 AND intent_revision = $4
         AND engine_config_revision = $5 AND stack_version_id = $6
         AND status = 'DEPLOYING' AND deploy_job_reference_id = $7
       RETURNING ${PROFILE_COLUMNS}`,
      [name, JSON.stringify(settings), owner.instanceId, owner.intentRevision,
        owner.configRevision, owner.stackVersionId, owner.jobReferenceId],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  /** The engine's config file as stored, whole, or null when the template runs. */
  async engineConfigOf(name: string): Promise<string | null> {
    const result = await this.pool.query<{ engine_config: string | null }>(
      'SELECT engine_config FROM profiles WHERE name = $1',
      [name],
    );
    return result.rows[0]?.engine_config ?? null;
  }

  /**
   * Stores the file and the outcome of the last apply in one statement, so a
   * revert that puts the previous file back cannot leave the error of the
   * attempt behind on a row that no longer runs it, or the other way round.
   */
  async setEngineConfig(
    name: string,
    config: string | null,
    error: string | null,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET engine_config = $2,
             engine_config_error = $3,
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, config, error],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  /**
   * The deployment's generated secrets. Read on their own rather than as a
   * column of every row, because a row travels: it is answered to the browser
   * and published on the event stream, and these values must not.
   */
  async stackSecretsOf(name: string): Promise<StackSecrets> {
    const result = await this.pool.query<{ stack_secrets: StackSecrets }>(
      'SELECT stack_secrets FROM profiles WHERE name = $1',
      [name],
    );
    return result.rows[0]?.stack_secrets ?? {};
  }

  /** Adds to what is stored. A key already held keeps its value. */
  async storeStackSecrets(name: string, secrets: StackSecrets): Promise<void> {
    await this.pool.query(
      `UPDATE profiles
         SET stack_secrets = $2::jsonb || stack_secrets,
             updated_at = NOW()
       WHERE name = $1`,
      [name, JSON.stringify(secrets)],
    );
  }

  async updateStampId(
    name: string,
    stampId: string,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET stamp_id = $2,
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, stampId],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  private async deleteProfile(
    name: string,
    claim: ProfileRemovalClaim,
    cleanFiles: () => Promise<void>,
  ): Promise<{ port_slot: number } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
      const selected = await client.query<Pick<Profile, 'status' | 'instance_id' | 'intent_revision'>>(
        'SELECT status, instance_id, intent_revision FROM profiles WHERE name = $1 FOR UPDATE', [name],
      );
      const row = selected.rows[0];
      if (!row || row.instance_id !== claim.instance_id || row.intent_revision !== claim.intent_revision || row.status !== 'REMOVING') {
        await client.query('COMMIT');
        return null;
      }
      if (row.status !== 'REMOVING') throw new ProfileConfigError(name, 'The deployment has not completed removal.');
      const held = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM deploy_attempts WHERE project = $1 AND state <> 'released')
          OR EXISTS (SELECT 1 FROM build_references WHERE ${OPERATION_HOLD_FOR_OWNER_SQL}) AS blocked
          FROM profiles owner WHERE owner.name = $1`, [name],
      );
      if (held.rows[0]?.blocked) throw new ProfileConfigError(name, 'An unresolved deploy attempt or rollback operation still holds this deployment.');
      // Keep the row locked and its name occupied until all name-owned files are gone.
      await cleanFiles();
      await client.query('DELETE FROM port_reservations WHERE profile_name = $1', [name]);
      await client.query(
        `UPDATE build_references SET resolved_at = NOW() WHERE resolved_at IS NULL
         AND ((holder_kind = 'job' AND holder_id = $1) OR (holder_kind = 'snapshot' AND split_part(holder_id, '/', 1) = $1))`, [name],
      );
      const result = await client.query<{ port_slot: number }>('DELETE FROM profiles WHERE name = $1 RETURNING port_slot', [name]);
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  /** The commit of a deploy that touched every service and found them all on it. */
  async setLastFullDeployCommit(name: string, commit: string): Promise<void> {
    await this.pool.query(
      'UPDATE profiles SET last_full_deploy_commit = $2, updated_at = NOW() WHERE name = $1',
      [name, commit],
    );
  }

  /**
   * An operator acted on the deployment: stop, start, edit, remove. Every
   * conditional write of a config rollout names the intent it started under,
   * so this ends an older rollout durably, a manager restart included.
   */
  async bumpIntent(name: string, expectedInstanceId?: string): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET intent_revision = intent_revision + 1, updated_at = NOW()
       WHERE name = $1 AND ($2::uuid IS NULL OR instance_id = $2)
       RETURNING ${PROFILE_COLUMNS}`,
      [name, expectedInstanceId ?? null],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async transitionStatus(
    name: string,
    next: ProfileStatus,
    allowedFrom: readonly ProfileStatus[],
    expectedInstanceId?: string,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = $2,
             deployment_phase = CASE
               WHEN $2 = 'DEPLOYING' THEN ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL}
               ELSE NULL END,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = NOW()
       WHERE name = $1 AND status = ANY($3::text[]) AND ($4::uuid IS NULL OR instance_id = $4)
       RETURNING ${PROFILE_COLUMNS}`,
      [name, next, allowedFrom, expectedInstanceId ?? null],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async markError(name: string, message: string): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = 'ERROR',
             deployment_phase = NULL,
             last_error = $2,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, message],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async markDeployError(
    name: string,
    owner: ExpectedDeployOwner,
    jobReferenceId: number | null,
    message: string,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
          SET status = 'ERROR', deployment_phase = NULL,
              last_error = $7, last_error_at = NOW(), updated_at = NOW()
        WHERE name = $1 AND status = 'DEPLOYING'
          AND instance_id = $2 AND intent_revision = $3
          AND engine_config_revision = $4 AND stack_version_id = $5
          AND deploy_job_reference_id IS NOT DISTINCT FROM $6::integer
        RETURNING ${PROFILE_COLUMNS}`,
      [name, owner.instanceId, owner.intentRevision, owner.configRevision,
        owner.stackVersionId, jobReferenceId, message],
    );
    return result.rows[0] ?? null;
  }

  async markTerminal(
    name: string,
    status: ProfileStatus,
    expectedInstanceId?: string,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = $2,
             deployment_phase = NULL,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = NOW()
       WHERE name = $1 AND ($3::uuid IS NULL OR instance_id = $3)
       RETURNING ${PROFILE_COLUMNS}`,
      [name, status, expectedInstanceId ?? null],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async resetOrphanedTransitions(): Promise<Profile[]> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = 'ERROR',
             deployment_phase = NULL,
             last_error = 'manager restarted while ' || status,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE status IN ('DEPLOYING', 'STOPPING', 'REMOVING')
       RETURNING ${PROFILE_COLUMNS}`,
    );
    return result.rows;
  }
}
