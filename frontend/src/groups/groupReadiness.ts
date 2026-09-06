import {
  ABR_LADDER_SIZE,
  type BeePublishersResult,
  drainedChequebooks,
  hasStampId,
  isDeadStampState,
  isInvalidUrlState,
  isLadderKind,
  type LadderRungState,
  PUBLISHABLE_RUNG_STATUS,
} from '@streaming-infra-manager/common';

import { CHEQUEBOOK_EMPTY, type Readiness } from '../deployments/readiness';
import { isRunning, isTransitional } from '../deployments/shape';
import type { DeploymentGroup, Profile } from '../types';
import type { ChequebookHealths } from '../uploaders/useChequebookHealths';

/**
 * One short line per rung that is holding the pool string back.
 *
 * The manager's own reasons are written for a log: complete, and far too long
 * to sit in a list on the overview. The rung state behind each of them says the
 * same thing in three words.
 *
 * An empty chequebook is added from what the rungs themselves reported, because
 * the manager assembles the pool string from stamps and reachability alone. A
 * rung that cannot pay its peers is still listed in the string, and an uploader
 * publishing to it uploads nothing on that rung.
 */
export function poolProblems(
  result: BeePublishersResult | null,
  chequebooks: ChequebookHealths = new Map(),
): string[] {
  if (!result) return [];

  const blocked = new Set(result.missing.map((note) => note.rung));
  const problems = result.missing.map((note) => {
    const rung = result.rungs.find((entry) => entry.rung === note.rung);
    return `${note.rung}: ${shortProblem(rung)}`;
  });

  const drained = new Set(
    drainedChequebooks(
      chequebooks,
      result.rungs.map((rung) => rung.name),
    ),
  );
  for (const rung of result.rungs) {
    if (blocked.has(rung.rung)) continue;
    if (drained.has(rung.name)) problems.push(`${rung.rung}: chequebook empty`);
  }

  return problems;
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
  chequebooks: ChequebookHealths = new Map(),
): Readiness {
  if (members.length === 0) {
    return { label: 'No members', tone: 'gray' };
  }

  if (isLadderKind(group.kind)) {
    // Ahead of the ready check, because the manager assembles the pool string
    // from stamps and reachability alone and calls a pool with a dry rung ready.
    // The problems list under the pill has been saying otherwise all along.
    const drained = drainedChequebooks(
      chequebooks,
      members.map((member) => member.name),
    );
    if (drained.length > 0) return { label: CHEQUEBOOK_EMPTY, tone: 'err' };

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
