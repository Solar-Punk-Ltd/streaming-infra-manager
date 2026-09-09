/**
 * The argument reader the manager's commands share.
 *
 * Every option is written `--name value`, except the switches, which take
 * none. Anything else is refused by name rather than guessed at, because
 * these commands run inside a deploy where a mistyped option would otherwise
 * be found out by its effect.
 */
export interface FlagSpec {
  /** Options taking one value, allowed once each. */
  readonly valued: readonly string[];
  /** Options taking one value, allowed more than once. */
  readonly repeated?: readonly string[];
  /** Options taking no value. */
  readonly switches?: readonly string[];
}

export interface Flags {
  /** The value given for an option, or a refusal naming the missing one. */
  required(name: string): string;
  /** Every value given for a repeated option, in the order they arrived. */
  list(name: string): readonly string[];
  has(name: string): boolean;
}

export function parseFlags(argv: readonly string[], spec: FlagSpec): Flags {
  const repeated = new Set(spec.repeated ?? []);
  const switches = new Set(spec.switches ?? []);
  const valued = new Set([...spec.valued, ...repeated]);
  const values = new Map<string, string[]>();
  const present = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (switches.has(flag)) {
      present.add(flag);
      continue;
    }
    if (!valued.has(flag)) throw new Error(`${flag} is not an option this command takes.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    index += 1;
    const given = values.get(flag);
    if (given && !repeated.has(flag)) throw new Error(`${flag} was given more than once.`);
    values.set(flag, [...(given ?? []), value]);
  }

  return {
    required: (name) => {
      const given = values.get(name);
      if (!given) throw new Error(`${name} is needed and was not given.`);
      return given[0]!;
    },
    list: (name) => values.get(name) ?? [],
    has: (name) => present.has(name),
  };
}

/**
 * Runs the argument reading of one command, so a refusal arrives with what
 * that command takes. Only the reading, because a failure later on is about
 * the host or the checkout rather than about how the command was called.
 */
export function withUsage<T>(usage: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
  }
}
