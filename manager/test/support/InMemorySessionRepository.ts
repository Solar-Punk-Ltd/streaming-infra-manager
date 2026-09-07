import type {
  NewSession,
  SessionRepository,
  StoredSession,
} from '../../src/domain/auth/SessionRepository.js';
import type { UserRepository } from '../../src/domain/auth/UserRepository.js';

interface SessionRow {
  tokenHash: string;
  userId: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/**
 * The sessions table without Postgres, for the tests.
 *
 * It asks the user repository for the username on every read, which is both
 * the join the real query does and the cascade on a deleted user: a session
 * whose owner is gone reads as no session at all.
 */
export class InMemorySessionRepository implements SessionRepository {
  private rows = new Map<string, SessionRow>();

  constructor(private readonly users: UserRepository) {}

  async create(session: NewSession): Promise<void> {
    const now = new Date();
    this.rows.set(session.tokenHash, {
      tokenHash: session.tokenHash,
      userId: session.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: session.expiresAt,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;

    const user = await this.users.findById(row.userId);
    if (!user) return null;

    return { ...row, username: user.username, isAdmin: user.is_admin };
  }

  async touch(tokenHash: string, seenAt: Date): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row) this.rows.set(tokenHash, { ...row, lastSeenAt: seenAt });
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.rows.delete(tokenHash);
  }

  async deleteForUser(userId: number): Promise<void> {
    this.removeWhere((row) => row.userId === userId);
  }

  /** The other half of a password change, paired with the hash write. */
  deleteForUserExcept(userId: number, keepTokenHash: string): void {
    this.removeWhere(
      (row) => row.userId === userId && row.tokenHash !== keepTokenHash,
    );
  }

  async deleteExpired(now: Date, idleSince: Date): Promise<number> {
    return this.removeWhere(
      (row) => row.expiresAt <= now || row.lastSeenAt <= idleSince,
    );
  }

  async findLiveTokenHashes(
    tokenHashes: readonly string[],
    now: Date,
    idleSince: Date,
  ): Promise<Set<string>> {
    const live = new Set<string>();
    for (const tokenHash of tokenHashes) {
      const session = await this.findByTokenHash(tokenHash);
      if (!session) continue;
      if (session.expiresAt > now && session.lastSeenAt > idleSince) {
        live.add(tokenHash);
      }
    }
    return live;
  }

  async countActiveByUser(
    now: Date,
    idleSince: Date,
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    for (const row of this.rows.values()) {
      if (row.expiresAt <= now || row.lastSeenAt <= idleSince) continue;
      counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
    }
    return counts;
  }

  /** Test-only view, so a test can assert what a revoke actually removed. */
  size(): number {
    return this.rows.size;
  }

  private removeWhere(matches: (row: SessionRow) => boolean): number {
    const kept = new Map<string, SessionRow>();
    let removed = 0;
    for (const [tokenHash, row] of this.rows) {
      if (matches(row)) removed += 1;
      else kept.set(tokenHash, row);
    }
    this.rows = kept;
    return removed;
  }
}
