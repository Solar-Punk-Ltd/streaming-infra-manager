import { Pool } from 'pg';

import type {
  NewSession,
  SessionRepository,
  StoredSession,
} from './SessionRepository.js';

interface SessionJoinRow {
  token_hash: string;
  user_id: number;
  username: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

function toStoredSession(row: SessionJoinRow): StoredSession {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    username: row.username,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(session: NewSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        session.tokenHash,
        session.userId,
        session.expiresAt,
        session.ip,
        session.userAgent,
      ],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    const result = await this.pool.query<SessionJoinRow>(
      `SELECT s.token_hash, s.user_id, u.username,
              s.created_at, s.last_seen_at, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? toStoredSession(row) : null;
  }

  async touch(tokenHash: string, seenAt: Date): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1',
      [tokenHash, seenAt],
    );
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
  }

  async deleteForUser(userId: number): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async deleteExpired(now: Date, idleSince: Date): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM sessions WHERE expires_at <= $1 OR last_seen_at <= $2',
      [now, idleSince],
    );
    return result.rowCount ?? 0;
  }

  async findLiveTokenHashes(
    tokenHashes: readonly string[],
    now: Date,
    idleSince: Date,
  ): Promise<Set<string>> {
    const result = await this.pool.query<{ token_hash: string }>(
      `SELECT token_hash
         FROM sessions
        WHERE token_hash = ANY($1)
          AND expires_at > $2
          AND last_seen_at > $3`,
      [tokenHashes, now, idleSince],
    );
    return new Set(result.rows.map((row) => row.token_hash));
  }

  async countActiveByUser(
    now: Date,
    idleSince: Date,
  ): Promise<Map<number, number>> {
    const result = await this.pool.query<{ user_id: number; count: number }>(
      `SELECT user_id, COUNT(*)::int AS count
         FROM sessions
        WHERE expires_at > $1 AND last_seen_at > $2
        GROUP BY user_id`,
      [now, idleSince],
    );
    return new Map(result.rows.map((row) => [row.user_id, row.count]));
  }
}
