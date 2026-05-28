import { Logger } from '../domain/Logger.js';

import { config } from './config.js';

const logger = Logger.getInstance();

/**
 * The address clients should use to reach deployed components. Components run on
 * the same host as the manager, so this is the server's own address, supplied
 * via PUBLIC_HOST (set by deploy.sh from the remote host's real IP — the
 * manager runs in a container and can't detect it itself). Falls back to
 * localhost for local development.
 */
export function resolveServerHost(): string {
  if (config.publicHost) {
    logger.info(`[serverHost] using PUBLIC_HOST=${config.publicHost}`);
    return config.publicHost;
  }

  logger.warn(
    '[serverHost] PUBLIC_HOST is not set; falling back to localhost. ' +
      'Component URLs will only work on this machine.',
  );
  return 'localhost';
}
