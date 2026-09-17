import {
  isDeadStampState,
  type LadderRungState,
  type StampHealth,
  type StampState,
} from '@streaming-infra-manager/common';

import type { PoolResults } from './useBeePublishers';

/** What each pool member's batch is worth, by profile name. */
export type PoolStampHealths = ReadonlyMap<string, StampHealth>;

/**
 * What the manager's own pool assembly already learned about a rung's batch.
 *
 * The manager asks every rung's node while it assembles a pool string, so a
 * page holding that result knows each member's batch state without asking a
 * node itself. `undefined` where the manager learned nothing, which is the same
 * position a page that never asked is in: the unknown state means the node did
 * not answer, and a node that is not answering is no evidence about its batch.
 */
export function rungStampHealth(
  rung: LadderRungState | null | undefined,
): StampHealth | undefined {
  if (!rung) return undefined;
  if (!rung.stampId) return healthOf('none', null);
  const state = rung.stampState;
  if (!state || state === 'unknown') return undefined;
  return healthOf(state, rung.stampTtl ?? null);
}

/** The same answer for every member of every pool a page holds a result for. */
export function poolStampHealths(results: PoolResults): PoolStampHealths {
  const healths = new Map<string, StampHealth>();
  for (const result of results.values()) {
    for (const rung of result?.rungs ?? []) {
      const health = rungStampHealth(rung);
      if (health) healths.set(rung.name, health);
    }
  }
  return healths;
}

function healthOf(state: StampState, ttl: number | null): StampHealth {
  return { state, ok: state === 'active', dead: isDeadStampState(state), ttl };
}
