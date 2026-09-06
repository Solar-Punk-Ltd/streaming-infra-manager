import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from '../Logger.js';

import type { AuthService } from './AuthService.js';

const logger = Logger.getInstance();

const MINUTE_MS = 60 * 1000;

export interface StreamRevalidation {
  stop(): void;
}

/**
 * Re-checks the sessions behind the open event streams once a minute, and
 * closes the streams whose session has ended.
 *
 * Revoking checks nothing on a clock: it closes the streams it revokes as it
 * goes. What is left for this is expiry, which no request announces. Without
 * it a session that simply ran out keeps its streams, and their events, until
 * the browser or the manager goes away.
 */
export function startStreamRevalidation(
  authService: AuthService,
  intervalMs: number = MINUTE_MS,
): StreamRevalidation {
  const revalidate = async (): Promise<void> => {
    try {
      const closed = await authService.closeStreamsOfEndedSessions();
      if (closed > 0) {
        logger.info(`[Auth] closed ${closed} stream(s) of ended session(s)`);
      }
    } catch (err) {
      logger.error(
        '[Auth] stream revalidation failed:',
        getErrorMessage(err),
      );
    }
  };

  const timer = setInterval(() => void revalidate(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
