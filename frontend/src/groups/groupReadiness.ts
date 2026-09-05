import {
  ABR_LADDER_SIZE,
  type BeePublishersResult,
  hasStampId,
  isDeadStampState,
  isInvalidUrlState,
  isLadderKind,
  type LadderRungState,
  PUBLISHABLE_RUNG_STATUS,
} from '@streaming-infra-manager/common';

import type { Readiness } from '../deployments/readiness';
import { isRunning, isTransitional } from '../deployments/shape';
import type { DeploymentGroup, Profile } from '../types';

/**
 * One short line per rung that is holding the pool string back.
 *
 * The manager's own reasons are written for a log: complete, and far too long
 * to sit in a list on the overview. The rung state behind each of them says the
 * same thing in three words.
 */
export function poolProblems(result: BeePublishersResult | null): string[] {
  if (!result || result.ready) return [];
  return result.missing.map((note) => {
    const rung = result.rungs.find((entry) => entry.rung === note.rung);
    return `${note.rung}: ${shortProblem(rung)}`;
  });
}

function shortProblem(rung: LadderRungState | undefined): string {
  if (!rung) return 'rung is missing';
  if (rung.status !== PUBLISHABLE_RUNG_STATUS) return 'node is not running';
  if (isInvalidUrlState(rung.urlState)) return 'address cannot be reached';
  if (!rung.stampId) return 'no stamp yet';
  if (isDeadStampState(rung.stampState)) return 'stamp expired';
  if (rung.stampState === 'pending') return 'stamp still settling';
  return 'not ready';
}

function stampedRungCount(
  result: BeePublishersResult | null,
  members: Profile[],
): number {
  if (!result) return members.filter(hasStampId).length;
  return result.rungs.filter(
    (rung) => rung.stampId && !isDeadStampState(rung.stampState),
  ).length;
}

export function groupReadinessOf(
  group: DeploymentGroup,
  members: Profile[],
  poolResult: BeePublishersResult | null,
): Readiness {
  if (members.length === 0) {
    return { label: 'No members', tone: 'gray' };
  }

  if (isLadderKind(group.kind)) {
    if (poolResult?.ready) return { label: 'Pool ready', tone: 'ok' };
    if (members.some(isTransitional)) {
      return { label: 'Deploying…', tone: 'info' };
    }
    return {
      label: `${stampedRungCount(poolResult, members)}/${ABR_LADDER_SIZE} rungs stamped`,
      tone: 'warn',
    };
  }

  if (members.every(isRunning)) return { label: 'All running', tone: 'ok' };
  if (members.some(isTransitional)) return { label: 'Changing…', tone: 'info' };
  if (members.some(isRunning)) return { label: 'Partly running', tone: 'warn' };
  return { label: 'Stopped', tone: 'gray' };
}
