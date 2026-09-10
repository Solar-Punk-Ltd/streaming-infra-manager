import assert from 'node:assert/strict';

import { redactEngineOutput } from './redactEngineOutput.js';

/**
 * Assertions that keep the value they are about out of the failure they print.
 *
 * A failing test's block carries the assertion's own `actual` and `expected`
 * fields, and `assert.equal` puts the whole diff in the error itself, so the
 * message an author writes is not the only thing published. What these two
 * compare is an engine tail and a stored engine config, and the config carries
 * a deployment's SRT passphrase and its webhook token.
 */

/** `assert.match` against the redacted copy, which is then the only copy printed. */
export function assertMatchesRedacted(text: string, pattern: RegExp, what: string): void {
  const redacted = redactEngineOutput(text);
  assert.match(redacted, pattern, `${what}: ${redacted}`);
}

/** `assert.equal(value, null)` reduced to its answer, so a value that is not null is never printed. */
export function assertNull(value: unknown, what: string): void {
  assert.equal(value === null, true, what);
}
