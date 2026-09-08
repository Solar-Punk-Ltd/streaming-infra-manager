import {
  type EngineSettings,
  nullify,
  type StackPortVar,
} from '@streaming-infra-manager/common';
import { Pool } from 'pg';

import { Profile, ProfileKind, ProfileStatus } from '../types/index.js';
import { reserveSlotFor } from './ports/reservationSql.js';
import { PROFILE_COLUMNS, PROFILE_SLOT_LOCK_KEY } from './profileSql.js';
import type { StackSecrets } from './versions/stackSecrets.js';

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

export class ProfileRepository {
  constructor(private readonly pool: Pool) {}

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
           srt_passphrase, group_id, bee_publishers, bee_url, stack_version_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET engine_settings = $2::jsonb,
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, JSON.stringify(settings)],
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

  async deleteByName(name: string): Promise<{ port_slot: number } | null> {
    const result = await this.pool.query<{ port_slot: number }>(
      'DELETE FROM profiles WHERE name = $1 RETURNING port_slot',
      [name],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  /** The commit of a deploy that touched every service and found them all on it. */
  async setLastFullDeployCommit(name: string, commit: string): Promise<void> {
    await this.pool.query(
      'UPDATE profiles SET last_full_deploy_commit = $2, updated_at = NOW() WHERE name = $1',
      [name, commit],
    );
  }

  async transitionStatus(
    name: string,
    next: ProfileStatus,
    allowedFrom: readonly ProfileStatus[],
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = $2,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = NOW()
       WHERE name = $1 AND status = ANY($3::text[])
       RETURNING ${PROFILE_COLUMNS}`,
      [name, next, allowedFrom],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async markError(name: string, message: string): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = 'ERROR',
             last_error = $2,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, message],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async markTerminal(
    name: string,
    status: ProfileStatus,
  ): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = $2,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [name, status],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async resetOrphanedTransitions(): Promise<Profile[]> {
    const result = await this.pool.query<Profile>(
      `UPDATE profiles
         SET status = 'ERROR',
             last_error = 'manager restarted while ' || status,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE status IN ('DEPLOYING', 'STOPPING', 'REMOVING')
       RETURNING ${PROFILE_COLUMNS}`,
    );
    return result.rows;
  }
}
