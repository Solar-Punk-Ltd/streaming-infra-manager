import { basename, dirname, join } from 'node:path';

import {
  BUNDLED_STACK_ROOT,
  bootstrapPairsFor,
  type BootstrapPair,
} from '../../utils/envUtils.js';

import { buildIdProblem, readBuildManifest } from './buildManifest.js';
import type { StackVersionLayout } from './StackVersionRepository.js';
import { versionRemovalProblem } from './versionRemovalMarker.js';

/**
 * Where one version's checkout keeps everything the manager runs against it.
 *
 * Every path the deploy machinery uses is derived here, from one root, so
 * pointing a deployment at another version is a different root and nothing
 * else. The bundled version carries no root of its own in the database, because
 * only the running manager knows where its own checkout is.
 */
export interface StackVersionRoot {
  id?: number;
  rootPath: string | null;
  /** Legacy when left out: a caller that names only a root means the flat one. */
  layout?: StackVersionLayout;
  buildId?: string | null;
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

const MISSING_BUILD_ROOT = 'This version uses immutable builds but has no artifact root. Restore its build before deploying.';
const MISSING_BUILD_ID = 'This version has no build to deploy from yet.';

/**
 * Where a version deploys from. A null rootPath is the bundled one. A legacy
 * row deploys from its flat root. A builds row deploys from its current
 * build, a sibling of the flat root, and never from the flat root itself,
 * so a missing build is a refusal from `deployRootProblem` and not a
 * fallback.
 */
export function stackRootOf(version: StackVersionRoot): string {
  if ((version.layout ?? 'legacy') !== 'builds') return version.rootPath ?? BUNDLED_STACK_ROOT;
  if (version.rootPath === null) throw new Error(MISSING_BUILD_ROOT);
  if (!version.buildId) throw new Error(MISSING_BUILD_ID);
  return buildDirFor(dirname(version.rootPath), basename(version.rootPath), version.buildId);
}

/** Why a version cannot be deployed from right now, naming what is missing, or null. */
export function deployRootProblem(version: StackVersionRoot): string | null {
  const removalProblem = versionRemovalProblem(version);
  if (removalProblem) return removalProblem;
  if ((version.layout ?? 'legacy') !== 'builds') return null;
  if (version.rootPath === null) return MISSING_BUILD_ROOT;
  if (!version.buildId) return MISSING_BUILD_ID;
  const problem = readBuildManifest(stackRootOf(version)).problem;
  return problem ? `Build ${version.buildId} of this version cannot be deployed from. ${problem}` : null;
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

/*
 * The layout of a version with builds. A dot cannot appear in a version name
 * (stack_versions_name_format in migration 010), so the three directories
 * below are siblings of the flat root and the flat root is never an ancestor
 * of a build, which is what keeps a legacy tree's removal from taking a build
 * with it.
 */
const REPO_SUFFIX = '.repo';
const BUILDS_SUFFIX = '.builds';
const STAGING_PREFIX = 'tmp-';

/** The clone a version fetches into. Never deployed from. */
export function repoRootFor(versionsRoot: string, name: string): string {
  return join(versionsRoot, `${name}${REPO_SUFFIX}`);
}

/** The parent of every build of the version, one immutable directory each. */
export function buildsRootFor(versionsRoot: string, name: string): string {
  return join(versionsRoot, `${name}${BUILDS_SUFFIX}`);
}

/** One build. Throws on an id that is not one, because the id becomes a path. */
export function buildDirFor(versionsRoot: string, name: string, buildId: string): string {
  const problem = buildIdProblem(buildId);
  if (problem) throw new Error(problem);
  return join(buildsRootFor(versionsRoot, name), buildId);
}

/** Where one build attempt stages its candidate. No two attempts share one. */
export function stagingDirFor(versionsRoot: string, name: string, attemptId: string): string {
  return join(buildsRootFor(versionsRoot, name), `${STAGING_PREFIX}${attemptId}`);
}

/**
 * Where the host-owned inputs of a version live: the base env, the deploy
 * config and the engine envs. The flat root the version always had, which a
 * legacy row also deploys from. The bundled version never had one: its
 * config root is created by its first publication and holds the inputs the
 * manager's deploy shipped.
 */
export function configRootFor(versionsRoot: string, name: string): string {
  return versionRootFor(versionsRoot, name);
}

/**
 * Where the manager's own deploy leaves the built bundled stack for the api
 * to publish at boot. A sibling of `bundled.builds`, not inside it, so
 * neither prune nor the cleanup of interrupted attempts ever looks at it.
 */
export const BUNDLED_INCOMING_DIR = 'bundled.incoming';

export function bundledIncomingRootFor(versionsRoot: string): string {
  return join(versionsRoot, BUNDLED_INCOMING_DIR);
}
