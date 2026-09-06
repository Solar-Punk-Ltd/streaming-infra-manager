import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from '@streaming-infra-manager/common';

import type { StoredSession } from './SessionRepository.js';

/**
 * How stale `last_seen_at` may get before a request writes it again. Without
 * this every request would be a write.
 */
export const LAST_SEEN_REFRESH_MS = 60 * 1000;

/** Sessions last seen before this moment have idled out. */
export function idleSince(now: Date): Date {
  return new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS);
}

export function absoluteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
}

/** When this session stops working if nothing else touches it. */
export function endsAt(session: StoredSession): Date {
  const idleEnd = session.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MS;
  return new Date(Math.min(session.expiresAt.getTime(), idleEnd));
}

export function hasExpired(session: StoredSession, now: Date): boolean {
  return endsAt(session).getTime() <= now.getTime();
}

export function needsTouch(session: StoredSession, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_REFRESH_MS;
}
