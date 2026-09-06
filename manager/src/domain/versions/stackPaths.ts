import { join } from 'node:path';

import {
  BUNDLED_STACK_ROOT,
  bootstrapPairsFor,
  type BootstrapPair,
} from '../../utils/envUtils.js';

/**
 * Where one version's checkout keeps everything the manager runs against it.
 *
 * Every path the deploy machinery uses is derived here, from one root, so
 * pointing a deployment at another version is a different root and nothing
 * else. The bundled version carries no root of its own in the database, because
 * only the running manager knows where its own checkout is.
 */
export interface StackVersionRoot {
  rootPath: string | null;
}

export interface StackPaths {
  root: string;
  deploy: string;
  stop: string;
  clean: string;
  health: string;
  baseEnv: string;
  envFile(profileName: string): string;
  /** Sample-to-live file pairs the checkout needs before a script runs. */
  bootstrapPairs: readonly BootstrapPair[];
}

/** The checkout a version lives in. A null rootPath is the bundled one. */
export function stackRootOf(version: StackVersionRoot): string {
  return version.rootPath ?? BUNDLED_STACK_ROOT;
}

export function stackPaths(version: StackVersionRoot): StackPaths {
  return stackPathsForRoot(stackRootOf(version));
}

export function stackPathsForRoot(root: string): StackPaths {
  const scripts = join(root, 'deploy', 'scripts');
  return {
    root,
    deploy: join(scripts, 'deploy.sh'),
    stop: join(scripts, 'stop.sh'),
    clean: join(scripts, 'clean.sh'),
    health: join(scripts, 'health.sh'),
    baseEnv: join(root, '.env'),
    envFile: (profileName: string) => join(root, `.env.${profileName}`),
    bootstrapPairs: bootstrapPairsFor(root),
  };
}

/**
 * Where an added version is checked out: one directory per version name under
 * STACK_VERSIONS_ROOT, bind-mounted into the api container at the same absolute
 * path it has on the host, which is what lets the compose files inside it
 * resolve their own relative volumes against the host filesystem.
 */
export function versionRootFor(versionsRoot: string, name: string): string {
  return join(versionsRoot, name);
}
