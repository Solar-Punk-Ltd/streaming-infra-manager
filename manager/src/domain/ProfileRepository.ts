import { Pool } from 'pg';

import { Profile, ProfileKind } from '../types.js';

export class ProfileRepository {
  constructor(private readonly pool: Pool) {}

  async findByName(name: string): Promise<Profile | null> {
    const r = await this.pool.query<Profile>(
      `SELECT name, port_prefix, kind, notes, created_at, updated_at
       FROM profiles WHERE name = $1`,
      [name],
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
  }

  async list(): Promise<Profile[]> {
    const result = await this.pool.query<Profile>(
      `SELECT name, port_prefix, kind, notes, created_at, updated_at
       FROM profiles ORDER BY port_prefix ASC`,
    );
    return result.rows;
  }

  async insert(
    name: string,
    portPrefix: number,
    kind: ProfileKind,
    notes: string | null,
  ): Promise<Profile> {
    const result = await this.pool.query<Profile>(
      `INSERT INTO profiles (name, port_prefix, kind, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING name, port_prefix, kind, notes, created_at, updated_at`,
      [name, portPrefix, kind, notes],
    );
    return result.rows[0]!;
  }

  async deleteByName(name: string): Promise<{ port_prefix: number } | null> {
    const result = await this.pool.query<{ port_prefix: number }>(
      'DELETE FROM profiles WHERE name = $1 RETURNING port_prefix',
      [name],
    );
    return result.rowCount && result.rowCount > 0 ? result.rows[0]! : null;
  }

  async getUsedPortsInOrder(): Promise<number[]> {
    const result = await this.pool.query<{ port_prefix: number }>(
      'SELECT port_prefix FROM profiles ORDER BY port_prefix ASC',
    );
    return result.rows.map((row) => row.port_prefix);
  }
}
