import { Pool } from 'pg';

import { USER_REMOVAL_LOCK_KEY } from './authSql.js';
import type {
  UserDeletion,
  UserRepository,
  UserRow,
} from './UserRepository.js';

const USER_COLUMNS =
  'id, username, password_hash, created_at, last_login_at, is_admin';

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async count(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    return result.rows[0]?.count ?? 0;
  }

  async list(): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC, id ASC`,
    );
    return result.rows;
  }

  async findById(id: number): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
      [username],
    );
    return result.rows[0] ?? null;
  }

  async insert(
    username: string,
    passwordHash: string,
    isAdmin: boolean,
  ): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (username, password_hash, is_admin)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING ${USER_COLUMNS}`,
      [username, passwordHash, isAdmin],
    );
    return result.rows[0] ?? null;
  }

  async markSignedIn(id: number, at: Date): Promise<void> {
    await this.pool.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [
      id,
      at,
    ]);
  }

  async deleteUnlessLast(id: number): Promise<UserDeletion> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        USER_REMOVAL_LOCK_KEY,
      ]);

      const counted = await client.query<{
        total: number;
        matching: number;
        admins: number;
        target_admin: boolean;
      }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE id = $1)::int AS matching,
                COUNT(*) FILTER (WHERE is_admin)::int AS admins,
                COALESCE(BOOL_OR(is_admin) FILTER (WHERE id = $1), false)
                  AS target_admin
           FROM users`,
        [id],
      );
      const row = counted.rows[0];

      if (!row || row.matching === 0) {
        await client.query('COMMIT');
        return 'missing';
      }
      if (row.total <= 1) {
        await client.query('COMMIT');
        return 'last';
      }
      if (row.target_admin && row.admins <= 1) {
        await client.query('COMMIT');
        return 'last_admin';
      }

      await client.query('DELETE FROM users WHERE id = $1', [id]);
      await client.query('COMMIT');
      return 'deleted';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
