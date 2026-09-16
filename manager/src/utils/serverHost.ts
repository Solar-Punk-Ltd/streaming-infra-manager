import { Logger } from '../domain/Logger.js';

import { config } from './config.js';

const logger = Logger.getInstance();

/**
 * The address clients use to reach the components of a deployment on the
 * manager's own host, supplied as PUBLIC_HOST (set by deploy.sh from the host's
 * real address, because the manager runs in a container and cannot detect it
 * itself). A deployment on a remote target gets its address from its own
 * resolved `network_host` instead, so this is the fallback for a local one.
 * Falls back to localhost for local development.
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
