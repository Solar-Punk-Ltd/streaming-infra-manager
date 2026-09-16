import { Logger } from './Logger.js';

const logger = Logger.getInstance();

/**
 * How often a read that keeps failing is allowed to say so.
 *
 * A readiness reading is shared for three seconds, so an open page asks again
 * every three seconds and each failed read wrote a warn line of its own. One
 * read against one node that is down is 1,200 lines an hour, and a four rung
 * pool asks six of them per rung. Every line is the same sentence, so the one
 * an operator wants, the first, is buried by the rest, and a node that came
 * back says nothing at all because only failures were ever written.
 *
 * So a spell of failures is one line when it starts, a reminder at most every
 * five minutes while it lasts, and one line when the read works again.
 */
export const READ_REMINDER_MS = 5 * 60_000;

/** What to say about a failure, where there is anything to say. */
export interface ReadFailureNote {
  /** The first failure after a working read, which is the line worth reading. */
  first: boolean;
  /** Every failure of this spell, including the one being reported. */
  failures: number;
  /** How long the read has been failing. */
  forMs: number;
}

/** What a read that works again cost while it was down. */
export interface ReadRecoveryNote {
  failures: number;
  forMs: number;
}

interface Spell {
  since: number;
  said: number;
  failures: number;
}

export interface NodeReadLogOptions {
  now?: () => number;
  reminderMs?: number;
}

/**
 * One spell of failures per read, so the log carries the shape of an outage
 * rather than a sample of it.
 *
 * A key names one read of one deployment. Nothing expires a key on its own,
 * because a spell ends when the read works again, so a deployment removed
 * while its node is down leaves one entry of three numbers behind.
 */
export class NodeReadLog {
  private readonly failing = new Map<string, Spell>();
  private readonly now: () => number;
  private readonly reminderMs: number;

  constructor({
    now = Date.now,
    reminderMs = READ_REMINDER_MS,
  }: NodeReadLogOptions = {}) {
    this.now = now;
    this.reminderMs = reminderMs;
  }

  /** The note this failure earns, or null while the spell is being held quiet. */
  failed(key: string): ReadFailureNote | null {
    const at = this.now();
    const spell = this.failing.get(key);
    if (!spell) {
      this.failing.set(key, { since: at, said: at, failures: 1 });
      return { first: true, failures: 1, forMs: 0 };
    }

    spell.failures += 1;
    if (at - spell.said < this.reminderMs) return null;
    spell.said = at;
    return { first: false, failures: spell.failures, forMs: at - spell.since };
  }

  /** What the spell that just ended cost, or null where there was none. */
  recovered(key: string): ReadRecoveryNote | null {
    const spell = this.failing.get(key);
    if (!spell) return null;
    this.failing.delete(key);
    return { failures: spell.failures, forMs: this.now() - spell.since };
  }

  /** Warns about a failure the spell has not already covered. */
  noteFailure(key: string, line: (note: ReadFailureNote) => string): void {
    const note = this.failed(key);
    if (note) logger.warn(line(note));
  }

  /** Reports a read that works again, and says nothing about one that never broke. */
  noteRecovery(key: string, line: (note: ReadRecoveryNote) => string): void {
    const note = this.recovered(key);
    if (note) logger.info(line(note));
  }
}

/** How long and how often, for a line an operator scans. */
export function spellText(note: ReadFailureNote | ReadRecoveryNote): string {
  const minutes = (note.forMs / 60_000).toFixed(1);
  return `${note.failures} failures over ${minutes} minutes`;
}

/** Empty for the line that opens a spell, which needs no count beside it. */
export function spellSuffix(note: ReadFailureNote): string {
  return note.first ? '' : ` (${spellText(note)})`;
}

/** One read of one deployment, or of one address. */
export function readLogKey(subject: string, what: string): string {
  return `${subject}:${what}`;
}
