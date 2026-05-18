import { Pool } from 'pg';

import { Profile, ProfileKind, ProfileStatus } from '../types/index.js';

const PROFILE_COLUMNS = `
  name, port_slot, kind, notes,
  components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
  status, last_error, last_error_at,
  created_at, updated_at
`;

export interface ProfileExtras {
  components?: string[] | null;
  host?: string | null;
  feed_owner?: string | null;
  feed_topic?: string | null;
  private_key?: string | null;
  public_key?: string | null;
  stamp_id?: string | null;
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

  async insert(
    name: string,
    portSlot: number,
    kind: ProfileKind,
    notes: string | null,
    status: ProfileStatus,
    extras: ProfileExtras = {},
  ): Promise<Profile> {
    const result = await this.pool.query<Profile>(
      `INSERT INTO profiles (
         name, port_slot, kind, notes, status,
         components, host, feed_owner, feed_topic, private_key, public_key, stamp_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${PROFILE_COLUMNS}`,
      [
        name,
        portSlot,
        kind,
        notes,
        status,
        extras.components ?? null,
        extras.host ?? null,
        extras.feed_owner ?? null,
        extras.feed_topic ?? null,
        extras.private_key ?? null,
        extras.public_key ?? null,
        extras.stamp_id ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async updateEditable(
    name: string,
    kind: ProfileKind,
    notes: string | null,
    extras: ProfileExtras = {},
  ): Promise<Profile | null> {
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
             updated_at = NOW()
       WHERE name = $1
       RETURNING ${PROFILE_COLUMNS}`,
      [
        name,
        kind,
        notes,
        extras.components ?? null,
        extras.feed_owner ?? null,
        extras.feed_topic ?? null,
        extras.private_key ?? null,
        extras.public_key ?? null,
        extras.stamp_id ?? null,
      ],
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

  async getUsedSlotsInOrder(): Promise<number[]> {
    const result = await this.pool.query<{ port_slot: number }>(
      'SELECT port_slot FROM profiles ORDER BY port_slot ASC',
    );
    return result.rows.map((row) => row.port_slot);
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

  /** Mark a profile as ERROR with a message. Best-effort, no CAS. */
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

  /** Move to a terminal status (RUNNING / STOPPED) on script success. */
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
