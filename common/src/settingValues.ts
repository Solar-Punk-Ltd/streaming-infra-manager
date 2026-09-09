import { ENGINE_CONFIG_FILE_MESSAGE, ENGINE_CONFIG_FILE_RE, isEngineConfigFileKey } from './engineConfig.js';

/**
 * What a value of a version's settings may be, for the page and the manager.
 *
 * Two readers see every one of these lines and they do not agree. The stack's
 * `load_env_file` in `deploy/scripts/_lib.sh` unwraps a value that opens with a
 * quote up to the next one, cuts an unquoted value at the first whitespace
 * followed by `#`, and strips the trailing whitespace. The manager's own
 * parser trims both ends and unwraps only a value quoted end to end. A value
 * that survives one and not the other is written through here and reaches the
 * containers as something the page never showed, which for a token means an
 * uploader that will not start and no message saying why.
 *
 * So the values these two read the same way are the values that may be saved,
 * and everything else is refused with the way to write it instead. The
 * refusal never repeats the value, because a settings value is a secret often
 * enough that no error path may carry one.
 */

/** Both readers cut a line here, and a value split across two lines is a second assignment. */
const LINE_BREAK_RE = /[\r\n]/;

/**
 * The C0 controls other than the tab, and the two Unicode line separators. A
 * NUL, a vertical tab and U+2028 all reached a file literally, and what reads
 * them next is a shell, a JSON parser and a browser in turn. The tab is left
 * out because it is whitespace these files legitimately hold, and the two
 * whitespace rules below cover where it matters.
 */
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u2028\u2029]/;

/** What the stack's loader treats as an inline comment and cuts an unquoted value at. */
const INLINE_COMMENT_RE = /[ \t]#/;

const QUOTES = ['"', "'"] as const;

/** Whether the value opens and closes with the same quote and holds no other one. */
function isQuotedEndToEnd(value: string): boolean {
  const quote = QUOTES.find((candidate) => value.startsWith(candidate));
  if (quote === undefined) return false;
  return value.length >= 2 && value.endsWith(quote) && !value.slice(1, -1).includes(quote);
}

/**
 * Why this value cannot be written into an env file, or null. The text reads
 * after the key it belongs to.
 */
export function envValueProblem(value: string): string | null {
  if (LINE_BREAK_RE.test(value)) {
    return 'cannot hold a line break, which would make it a second key. Write the value on one line.';
  }
  if (CONTROL_RE.test(value)) {
    return 'cannot hold a control character, which the readers of this file each treat differently. Write the value as plain text.';
  }
  if (isQuotedEndToEnd(value)) return null;
  if (QUOTES.some((quote) => value.startsWith(quote))) {
    return 'opens with a quote and does not close with the same quote at the end, so the stack reads part of it and the manager reads all of it. Close the quote, or take the opening one off.';
  }
  if (value !== value.trim()) {
    return 'cannot begin or end with a space, because the stack strips it and the manager keeps it. Put the value in quotes if the spaces belong to it.';
  }
  if (INLINE_COMMENT_RE.test(value)) {
    return 'cannot hold a space before a #, which the stack reads as the start of a comment and cuts the value at. Put the value in quotes if the # belongs to it.';
  }
  return null;
}

/**
 * Why this key cannot hold this value, or null.
 *
 * Two keys carry more than the env rule: `SRS_CONF_FILE` and `OME_CONF_FILE`
 * become the source of a Docker bind mount in the version's compose override,
 * so a value that is not a plain absolute path is a mount of something else or
 * a compose file that will not parse.
 */
export function settingValueProblem(key: string, value: string): string | null {
  const problem = envValueProblem(value);
  if (problem) return problem;
  if (!isEngineConfigFileKey(key) || value === '' || ENGINE_CONFIG_FILE_RE.test(value)) return null;
  return ENGINE_CONFIG_FILE_MESSAGE;
}
