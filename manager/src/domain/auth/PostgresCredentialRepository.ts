import { Pool } from 'pg';

import type { CredentialRepository } from './CredentialRepository.js';
import type { NewSession } from './SessionRepository.js';

export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly pool: Pool) {}

  async admitSession(
    userId: number,
    verifiedPasswordHash: string,
    session: NewSession,
    signedInAt: Date,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (current.rows[0]?.password_hash !== verifiedPasswordHash) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.tokenHash, userId, session.expiresAt, session.ip, session.userAgent],
      );
      await client.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [userId, signedInAt]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async changePassword(
    userId: number,
    verifiedPasswordHash: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (current.rows[0]?.password_hash !== verifiedPasswordHash) {
        await client.query('COMMIT');
        return false;
      }
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        userId,
        passwordHash,
      ]);
      await client.query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
        [userId, keepSessionTokenHash],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
