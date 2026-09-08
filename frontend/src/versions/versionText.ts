import {
  type ObservedContainer,
  runningCommitOf,
  type StackVersion,
} from '@streaming-infra-manager/common';

import { formatDateTime, shortCommit } from '../format';

const COMMIT_UNKNOWN = 'commit unknown on this host';
const NOT_OBSERVED = 'not observed yet';

/** Only a recorded invalidation can say that an update removed approval. */
export function lostApprovalWarning(version: StackVersion): string | null {
  return !version.tested && version.testedInvalidatedAt
    ? `Not tested since the update on ${formatDateTime(version.testedInvalidatedAt)}.`
    : null;
}

export function approvalStatusText(version: StackVersion): string {
  return lostApprovalWarning(version) ?? (version.tested
    ? 'Tested on this host.'
    : 'Not currently marked as tested on this host.');
}

/**
 * `bundled @ ee99c36`, or the name alone when the host cannot name a commit.
 *
 * A commit is unknown when the checkout arrived without a .git and without the
 * file deploy.sh writes next to it, which is a real state and not an error.
 */
export function describeVersion(version: StackVersion): string {
  return version.commitSha
    ? `${version.name} @ ${shortCommit(version.commitSha)}`
    : `${version.name}, ${COMMIT_UNKNOWN}`;
}

/**
 * Where the version deploys from: `build ee99c36` for a builds row, with
 * `-r2` and the like kept, `flat root` for a legacy one, `with the manager`
 * for the bundled checkout.
 */
export function describeBuild(version: StackVersion): string {
  if (version.layout === 'builds') {
    return version.buildId ? `build ${shortBuildId(version.buildId)}` : 'no build yet';
  }
  return version.name === 'bundled' ? 'with the manager' : 'flat root';
}

/** The build the current one replaced, or an empty string. */
export function describePreviousBuild(version: StackVersion): string {
  return version.previousBuildId ? `previous ${shortBuildId(version.previousBuildId)}` : '';
}

/** A build id shortened the way a commit is, with the rebuild suffix kept. */
export function shortBuildId(buildId: string): string {
  const [commit, suffix] = buildId.split(/(?=-r\d+$)/);
  return `${shortCommit(commit ?? buildId)}${suffix ?? ''}`;
}

/**
 * What the deployment's containers were seen to run: one commit, or each
 * service's own when they differ, or that nothing has been observed yet.
 */
export function describeRunning(containers: readonly ObservedContainer[]): string {
  const running = runningCommitOf(containers);
  if (running.kind === 'one') return `commit ${shortCommit(running.commit)}`;
  if (running.kind === 'unknown') return NOT_OBSERVED;
  return `mixed: ${running.byService
    .map(({ service, commit }) => `${service} ${commit ? shortCommit(commit) : NOT_OBSERVED}`)
    .join(', ')}`;
}
