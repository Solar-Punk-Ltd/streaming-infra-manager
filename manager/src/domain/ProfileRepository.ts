import {
  type EngineSettings,
  nullify,
} from '@streaming-infra-manager/common';
import { Pool } from 'pg';

import { Profile, ProfileKind, ProfileStatus } from '../types/index.js';
import { PROFILE_COLUMNS, PROFILE_SLOT_LOCK_KEY } from './profileSql.js';

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
    data: ProfileWriteData = {},
  ): Promise<Profile | null> {
    const dataWithNullFields = nullify(data);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        PROFILE_SLOT_LOCK_KEY,
      ]);
      const result = await client.query<Profile>(
        `INSERT INTO profiles (
           name, port_slot, kind, notes, status,
           components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
           srt_passphrase, group_id, bee_publishers, bee_url
         )
         SELECT $1, s.n, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         FROM generate_series(1, 999) AS s(n)
         LEFT JOIN profiles p ON p.port_slot = s.n
         WHERE p.port_slot IS NULL
         ORDER BY s.n
         LIMIT 1
         RETURNING ${PROFILE_COLUMNS}`,
        [
          name,
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
