import { Pool } from 'pg';

import type { CredentialRepository } from './CredentialRepository.js';

export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly pool: Pool) {}

  async changePassword(
    userId: number,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        userId,
        passwordHash,
      ]);
      await client.query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
        [userId, keepSessionTokenHash],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
