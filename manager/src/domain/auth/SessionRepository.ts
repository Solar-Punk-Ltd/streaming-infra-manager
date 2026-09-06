/**
 * Sessions as stored. Nothing here decides whether a session is still valid:
 * that rule lives in sessionLifetime.ts, so the two implementations of this
 * interface cannot drift on it.
 */
export interface StoredSession {
  tokenHash: string;
  userId: number;
  username: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface NewSession {
  tokenHash: string;
  userId: number;
  /** The absolute deadline, whatever the session's activity. */
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionRepository {
  create(session: NewSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>;
  touch(tokenHash: string, seenAt: Date): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteForUser(userId: number): Promise<void>;
  /** Removes what is past its absolute deadline or idle since `idleSince`. */
  deleteExpired(now: Date, idleSince: Date): Promise<number>;
  /**
   * Which of these sessions are still live, in one query rather than one per
   * token hash. Asked about the sessions holding an event stream open.
   */
  findLiveTokenHashes(
    tokenHashes: readonly string[],
    now: Date,
    idleSince: Date,
  ): Promise<Set<string>>;
  /** Open sessions per user id, for the Access page's count. */
  countActiveByUser(now: Date, idleSince: Date): Promise<Map<number, number>>;
}
