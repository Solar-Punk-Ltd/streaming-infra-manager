import { existsSync } from 'node:fs';

/**
 * The host the manager reaches a deployment's published ports on.
 *
 * Inside its own container the manager reaches the host's ports through
 * host.docker.internal, which manager/docker-compose.yml maps to the host
 * gateway. Running natively, in development or the integration suite, that
 * name does not resolve, so the loopback address is used. BEE_LOCAL_HOST
 * overrides both, and keeps its name from when only the Bee API was reached
 * this way.
 */
export const LOCAL_PUBLISHED_HOST =
  process.env.BEE_LOCAL_HOST ??
  (existsSync('/.dockerenv') ? 'host.docker.internal' : '127.0.0.1');
