/**
 * Where a manager command writes.
 *
 * Standard output carries the one machine-read line a caller parses, and
 * nothing else. Everything a person reads goes to standard error, so a deploy
 * script can capture the first without filtering the second.
 */
export interface CommandStreams {
  out(line: string): void;
  err(line: string): void;
}

/** The prefix every human-readable line of a manager command carries. */
export const CLI_PREFIX = '[cli]';

export const processStreams: CommandStreams = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};
