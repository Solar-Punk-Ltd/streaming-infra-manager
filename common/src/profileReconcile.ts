/** What reconciling needs of a row: which row it is, and when it last changed. */
export interface TimestampedRow {
  name: string;
  updated_at: string;
}

const changedAtMs = (row: TimestampedRow): number => Date.parse(row.updated_at);

/**
 * Folds a freshly fetched list into the one already on screen, without undoing
 * what live events changed while the fetch was in flight.
 *
 * The fetch and the event stream race, so the response can describe an older
 * state than the screen already holds. A row both lists have keeps whichever
 * copy changed last, and a row the response dropped survives only if it changed
 * after the request went out, which is the only way it can be newer than the
 * answer. Everything else follows the response, in the order the API gave it.
 *
 * `fetchStartedAt` is a local clock reading while `updated_at` comes from the
 * server, so a badly skewed client clock can hold a removed row or drop a new
 * one for one reload. The next event for that row corrects it either way.
 */
export function reconcileProfiles<Row extends TimestampedRow>(
  previous: readonly Row[],
  snapshot: readonly Row[],
  fetchStartedAt: number,
): Row[] {
  const inSnapshot = new Set(snapshot.map((row) => row.name));
  const onScreen = new Map(previous.map((row) => [row.name, row]));

  const arrivedDuringFetch = previous.filter(
    (row) => !inSnapshot.has(row.name) && changedAtMs(row) >= fetchStartedAt,
  );

  const merged = snapshot.map((row) => {
    const mine = onScreen.get(row.name);
    return mine && changedAtMs(mine) > changedAtMs(row) ? mine : row;
  });

  return [...arrivedDuringFetch, ...merged];
}
