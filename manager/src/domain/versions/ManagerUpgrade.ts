import { isDeepStrictEqual } from 'node:util';
import { ManagerUpgradeGuard } from './managerUpgradeGuard.js';

export interface ManagerUpgradeRequest {
  manager: { sourceCommit: string; sourceDigest: string; imageId: string };
  project: string;
}

/**
 * How much of the manager's schema the database already has: nothing at all,
 * everything from before the publication revision arrived, or the current one.
 */
export type ManagerSchemaState = 'fresh' | 'pre-journal' | 'current';
const SCHEMA_STATES: readonly ManagerSchemaState[] = ['fresh', 'pre-journal', 'current'];

export interface ManagerPublication {
  schema: ManagerSchemaState;
}

/** Where the bundled version got to while the upgrade waited for it. */
export interface BundledBuildOutcome {
  state: 'ready' | 'failed' | 'timed-out' | 'unpinned';
  /** The commit the manager pins, or null when it pins none. */
  commit: string | null;
  buildId: string | null;
  /** What the version row last said went wrong, for a state that is not ready. */
  problem: string | null;
}

/**
 * Operations use the exact staged image and one Compose project. Each command
 * has its own bounded supervisor, and the bundled wait its own bound.
 */
export interface ManagerUpgradeOperations {
  readPublication(request: ManagerUpgradeRequest): Promise<ManagerPublication>;
  stopApi(request: ManagerUpgradeRequest): Promise<void>;
  migrate(request: ManagerUpgradeRequest): Promise<void>;
  startProject(request: ManagerUpgradeRequest): Promise<void>;
  verifyProject(request: ManagerUpgradeRequest): Promise<void>;
  awaitBundledBuild(request: ManagerUpgradeRequest): Promise<BundledBuildOutcome>;
}

export interface ManagerUpgradeResult {
  state: 'completed';
  bundled: BundledBuildOutcome;
}

const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** The request as this upgrade will use it: every field checked, frozen, and no field the caller added. */
export function captureManagerUpgradeRequest(input: ManagerUpgradeRequest): ManagerUpgradeRequest {
  const request = structuredClone(input);
  const fields = (value: unknown, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), keys.sort());
  const matches = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
  if (!fields(request, ['manager', 'project']) ||
    !fields(request.manager, ['sourceCommit', 'sourceDigest', 'imageId']) ||
    !matches(request.manager.sourceCommit, COMMIT) ||
    !matches(request.manager.sourceDigest, DIGEST) || !matches(request.manager.imageId, /^sha256:[a-f0-9]{64}$/) ||
    !matches(request.project, /^[a-z0-9][a-z0-9_-]{0,62}$/)) throw new Error('Invalid manager upgrade identity fields.');
  Object.freeze(request.manager); return Object.freeze(request);
}

/**
 * One upgrade at a time on this host, holding a directory for its whole run.
 *
 * There is nothing to publish here and nothing to replay: the deploy ships the
 * manager and the commit it pins, and the api builds that commit itself once it
 * is up. So the last thing this does is wait for that build and report it. A
 * build that failed is answered rather than thrown, because by then the manager
 * is running and the deployer can retry it from the Versions page, and a run
 * that stopped before that keeps its directory for a person to look at.
 */
export async function runManagerUpgrade(environment: { guardRoot: string; mutableRoot: string }, input: ManagerUpgradeRequest,
  operations: ManagerUpgradeOperations): Promise<ManagerUpgradeResult> {
  const request = captureManagerUpgradeRequest(input);
  const guard = new ManagerUpgradeGuard(environment.guardRoot, environment.mutableRoot);
  guard.acquire(request);
  let effectStarted = false;
  try {
    const current = await operations.readPublication(request);
    if (!SCHEMA_STATES.includes(current?.schema)) throw new Error('Current manager publication cannot be verified.');
    guard.phase('stopping'); effectStarted = true; await operations.stopApi(request);
    guard.phase('migrating'); await operations.migrate(request);
    guard.phase('starting'); await operations.startProject(request);
    guard.phase('verifying'); await operations.verifyProject(request);
    guard.phase('bundled');
    // The api answers by now, so nothing this wait does may keep the host held.
    let bundled: BundledBuildOutcome;
    try { bundled = await operations.awaitBundledBuild(request); } catch (error) { guard.release(); throw error; }
    guard.release(); return { state: 'completed', bundled };
  } catch (error) {
    if (!effectStarted) guard.release();
    throw error;
  }
}
