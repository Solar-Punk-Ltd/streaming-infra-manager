/**
 * Whether the cadence may start another round of node checks now.
 *
 * A round asks six manager routes and each of them gives the node up to ten
 * seconds, which is the cadence itself, so on a slow node every round was
 * superseded before it returned. None of them ever wrote its answers, and
 * thirty seconds later the card read "Bee observation stale" and stayed that
 * way until an operator pressed Retry. A hidden tab is skipped as well: a pool
 * page carries one of these per rung, and nobody is reading any of them.
 */
export function shouldRunTick(inFlight: boolean, hidden: boolean): boolean {
  return !inFlight && !hidden;
}

/** A round of node checks, and the handle that ends its six requests. */
export interface BeeCheckRound {
  id: number;
  signal: AbortSignal;
}

/**
 * Keeps one round of node checks at a time and says whose answers still count.
 *
 * Two rounds can still overlap, because a manual reload starts one whatever
 * the cadence is doing. The newer one wins and the older one's requests are
 * ended, rather than left in flight against a node that is already slow.
 */
export class BeeCheckRounds {
  private newest = 0;
  private running: { id: number; controller: AbortController } | null = null;

  get inFlight(): boolean {
    return this.running !== null;
  }

  begin(): BeeCheckRound {
    this.running?.controller.abort();
    const id = ++this.newest;
    const controller = new AbortController();
    this.running = { id, controller };
    return { id, signal: controller.signal };
  }

  isNewest(id: number): boolean {
    return id === this.newest;
  }

  end(id: number): void {
    if (this.running?.id === id) this.running = null;
  }

  /** For an unmount or a change of profile: nothing in flight may write again. */
  abandon(): void {
    this.running?.controller.abort();
    this.running = null;
    this.newest += 1;
  }
}
