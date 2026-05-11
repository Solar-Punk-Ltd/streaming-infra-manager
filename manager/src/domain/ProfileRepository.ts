import { Pool } from 'pg';

import { Profile, ProfileKind, ProfileStatus } from '../types.js';

const PROFILE_COLUMNS = `
  name, port_slot, kind, notes,
  status, last_error, last_error_at,
  created_at, updated_at
`;

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
  ): Promise<Profile> {
    const result = await this.pool.query<Profile>(
      `INSERT INTO profiles (name, port_slot, kind, notes, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PROFILE_COLUMNS}`,
      [name, portSlot, kind, notes, status],
    );
    return result.rows[0]!;
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

  /**
   * Compare-and-swap status transition. Updates the row only if its current
   * status is in `allowedFrom`. Returns the updated row, or null when the
   * caller lost the race / the profile is in a state that can't transition.
   */
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
  async markError(name: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE profiles
         SET status = 'ERROR',
             last_error = $2,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE name = $1`,
      [name, message],
    );
  }

  /** Move to a terminal status (RUNNING / STOPPED) on script success. */
  async markTerminal(name: string, status: ProfileStatus): Promise<void> {
    await this.pool.query(
      `UPDATE profiles
         SET status = $2,
             last_error = NULL,
             last_error_at = NULL,
             updated_at = NOW()
       WHERE name = $1`,
      [name, status],
    );
  }

  /**
   * On boot, any profile stuck in a transitional state is unrecoverable —
   * the in-process orchestrator that owned it died. Flip them to ERROR so
   * the user can retry. Returns the affected names for logging.
   */
  async resetOrphanedTransitions(): Promise<string[]> {
    const result = await this.pool.query<{ name: string; status: string }>(
      `UPDATE profiles
         SET status = 'ERROR',
             last_error = 'manager restarted while ' || status,
             last_error_at = NOW(),
             updated_at = NOW()
       WHERE status IN ('DEPLOYING', 'STOPPING', 'REMOVING')
       RETURNING name, status`,
    );
    return result.rows.map((r) => r.name);
  }
}
