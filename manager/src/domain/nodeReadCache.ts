/**
 * One call to a bee node per reading per window, however many callers ask.
 *
 * A deployment page asks six readiness routes per node card on a ten second
 * cadence, and every one of them used to build a client and ask the node
 * itself. Two open pages on a four rung pool cost the node about eighty
 * requests every ten seconds, four of which make it call its chain RPC, which
 * the stack documents as a public endpoint that rate limits hard.
 *
 * So callers that only render a reading share one: concurrent asks join the
 * call already in flight, and its answer stands for a short window afterwards.
 * A caller about to *act* on a reading uses `readFresh`, which asks the node
 * and drops the window the sharers were on, because a value three seconds old
 * is fine to draw and is not fine to start an uploader on.
 */

/** How long a reading stands before the node is asked for it again. */
export const NODE_READ_WINDOW_MS = 3_000;

interface HeldRead {
  answer: Promise<unknown>;
  /** When the call settled, or null while it is still in flight. */
  settledAt: number | null;
}

export interface NodeReadCacheOptions {
  windowMs?: number;
  now?: () => number;
}

export class NodeReadCache {
  private readonly held = new Map<string, HeldRead>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor({
    windowMs = NODE_READ_WINDOW_MS,
    now = Date.now,
  }: NodeReadCacheOptions = {}) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /**
   * The reading under `key`, from the node or from the open window.
   *
   * A refusal is held like an answer and for no longer: a node that is down
   * would otherwise be asked by every caller of every page, which is the load
   * this exists to remove, and a window that outlived a refusal would keep
   * reporting a node as unreachable after it came back.
   */
  read<T>(key: string, ask: () => Promise<T>): Promise<T> {
    const open = this.held.get(key);
    if (open && this.isOpen(open)) return open.answer as Promise<T>;

    const held: HeldRead = { answer: ask(), settledAt: null };
    const settled = () => {
      held.settledAt = this.now();
    };
    // Both branches, and nothing rethrows: this copy exists to time the call,
    // and a rejection nobody handles ends the process.
    void held.answer.then(settled, settled);
    this.dropClosed();
    this.held.set(key, held);
    return held.answer as Promise<T>;
  }

  /** The node now, for a caller that is about to act on what it says. */
  async readFresh<T>(key: string, ask: () => Promise<T>): Promise<T> {
    this.held.delete(key);
    try {
      return await ask();
    } finally {
      // A window opened while this ran holds a reading from before whatever
      // the caller is doing, so it goes too rather than being left to expire.
      this.held.delete(key);
    }
  }

  /** Drops every window for one profile, after something changed the node. */
  forget(name: string): void {
    for (const key of this.held.keys()) {
      if (key.startsWith(`${name}:`)) this.held.delete(key);
    }
  }

  private isOpen(held: HeldRead): boolean {
    return (
      held.settledAt === null || this.now() - held.settledAt < this.windowMs
    );
  }

  private dropClosed(): void {
    for (const [key, held] of this.held) {
      if (!this.isOpen(held)) this.held.delete(key);
    }
  }
}

/** Where a reading is held: one profile, one route. */
export function nodeReadKey(name: string, route: string): string {
  return `${name}:${route}`;
}
