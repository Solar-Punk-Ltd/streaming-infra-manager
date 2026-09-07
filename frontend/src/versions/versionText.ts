import type { StackVersion } from '@streaming-infra-manager/common';

import { shortCommit } from '../format';

const COMMIT_UNKNOWN = 'commit unknown on this host';

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
