import type { DeployAttemptView } from '@streaming-infra-manager/common';

/** As much of a deployment as the hold rule needs. */
export interface DeploymentInFlight {
  name: string;
  status: string;
}

const DEPLOYING = 'DEPLOYING';

/**
 * Whether an attempt is waiting for a person: blocked, or still open with no
 * deploy of its deployment in flight, which is an attempt the manager could
 * not judge when its script ended. An open attempt behind a running deploy
 * is that deploy, and it resolves on its own when the script ends.
 */
export function needsRelease(
  attempt: DeployAttemptView,
  deployments: readonly DeploymentInFlight[] | null,
): boolean {
  if (attempt.state === 'blocked') return true;
  if (attempt.state !== 'open') return false;
  const deployment = deployments?.find((entry) => entry.name === attempt.project);
  return deployment === undefined || deployment.status !== DEPLOYING;
}

/** The attempt holding a deployment that a person has to look at, or null. */
export function attemptHolding(
  name: string,
  attempts: readonly DeployAttemptView[],
  deployments: readonly DeploymentInFlight[] | null,
): DeployAttemptView | null {
  return (
    attempts.find(
      (attempt) => attempt.project === name && needsRelease(attempt, deployments),
    ) ?? null
  );
}
