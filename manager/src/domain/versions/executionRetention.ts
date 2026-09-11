import type { ExecutionRootRecord } from './ExecutionRoot.js';

/**
 * A deployment's copies, newest first.
 *
 * The timestamp decides, and identity breaks a tie, so two readings of the
 * same rows agree on which copy is the current one.
 */
function newestFirst(records: readonly ExecutionRootRecord[]): ExecutionRootRecord[] {
  return [...records].sort((left, right) =>
    right.createdAt.valueOf() - left.createdAt.valueOf() || right.executionId.localeCompare(left.executionId));
}

/** Only a launched copy can be the one a deployment runs from, or one it replaced. */
function launchedFor(records: readonly ExecutionRootRecord[], profileName: string): ExecutionRootRecord[] {
  return newestFirst(records.filter(record => record.profile.name === profileName && record.state === 'launch-uncertain'));
}

/**
 * The copy this deployment is running its scripts from, or null when it has
 * none and still runs from the version's build.
 *
 * Scoped to the instance as well as the name: a deployment removed and created
 * again under the same name is a different deployment, and the copies of the
 * one before it are nobody's to run from.
 */
export function currentExecutionOf(
  records: readonly ExecutionRootRecord[],
  profile: { name: string; instanceId: string },
): ExecutionRootRecord | null {
  return launchedFor(records, profile.name).find(record => record.profile.instanceId === profile.instanceId) ?? null;
}

/**
 * The copies this deployment no longer wants, oldest last.
 *
 * D11: the current copy and the one before it stay, so a deploy that fails
 * leaves the tree that last worked in place. `keepPrevious` is true while a
 * deploy is in flight and false once one has succeeded, which is the moment
 * the previous copy stops being worth keeping.
 *
 * Copies of an earlier instance of the same name are offered too, because a
 * removed deployment's copies belong to nobody. Every offer is only an offer:
 * the row's own job must have finished, and the database refuses the ones
 * whose have not.
 */
export function executionsToRetire(
  records: readonly ExecutionRootRecord[],
  input: { profileName: string; keepPrevious: boolean },
): ExecutionRootRecord[] {
  return launchedFor(records, input.profileName).slice(input.keepPrevious ? 2 : 1);
}
