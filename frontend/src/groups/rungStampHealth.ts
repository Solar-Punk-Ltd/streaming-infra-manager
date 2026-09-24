import {
  isDeadStampState,
  type LadderRungState,
  sameBatchId,
  type StampHealth,
  type StampState,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import type { StampHealths } from '../uploaders/useStampHealths';
import type { PoolResults } from './useBeePublishers';

/**
 * What the manager's own pool assembly already learned about a rung's batch.
 *
 * The manager asks every rung's node while it assembles a pool string, so a
 * page holding that result knows each member's batch state without asking a
 * node itself. `undefined` where the manager learned nothing, which is the same
 * position a page that never asked is in: the unknown state means the node did
 * not answer, and a node that is not answering is no evidence about its batch.
 *
 * `recordedStampId` is the batch the member records now. A pool result is a
 * reading of one moment, and a member that has just bought a batch carries one
 * the reading never saw, so a verdict about the old batch is no verdict about
 * this member.
 */
export function rungStampHealth(
  rung: LadderRungState | null | undefined,
  recordedStampId: string | null | undefined,
): StampHealth | undefined {
  if (!rung) return undefined;
  const recorded = recordedStampId?.trim() || null;
  if (!rung.stampId) return recorded ? undefined : healthOf('none');
  if (!recorded || !sameBatchId(rung.stampId, recorded)) return undefined;
  const state = rung.stampState;
  if (!state || state === 'unknown') return undefined;
  return healthOf(state, rung);
}

/** The same answer for every member of every pool a page holds a result for. */
export function poolStampHealths(
  results: PoolResults,
  profiles: Profile[] | null,
): StampHealths {
  const recorded = new Map(
    (profiles ?? []).map((profile) => [profile.name, profile.stamp_id]),
  );
  const healths = new Map<string, StampHealth>();
  for (const result of results.values()) {
    for (const rung of result?.rungs ?? []) {
      const health = rungStampHealth(rung, recorded.get(rung.name));
      if (health) healths.set(rung.name, health);
    }
  }
  return healths;
}

function healthOf(
  state: StampState,
  rung: Pick<LadderRungState, 'stampTtl' | 'stampFillRatio' | 'stampImmutable'> = {},
): StampHealth {
  return {
    state,
    ok: state === 'active',
    dead: isDeadStampState(state),
    ttl: rung.stampTtl ?? null,
    fillRatio: rung.stampFillRatio ?? null,
    immutable: rung.stampImmutable ?? null,
  };
}

/**
 * One reading per deployment, from the two ways a page comes by one.
 *
 * The manager reads every rung's batch while it assembles a pool string, and
 * that reading is the one to keep for a member it covers: it is taken with the
 * pool's own fetch rather than by asking the same node again. A page's own poll
 * answers for every node no pool result covers, and for a member whose pool
 * result has not arrived.
 */
export function mergedStampHealths(
  fromPools: StampHealths,
  fromNodes: StampHealths,
): StampHealths {
  return new Map([...fromNodes, ...fromPools]);
}
