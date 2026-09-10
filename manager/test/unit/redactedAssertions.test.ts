/**
 * What a failing assertion prints, which is more than its message.
 *
 * node's reporter puts the assertion's own `actual`, `expected` and `operator`
 * into the failing test's block, and `assert.equal` appends the whole diff to
 * the error itself. So a test that compares a raw value publishes that value
 * on failure, however carefully its message was written. T01's integration
 * file compares two of them: the rollout reason embeds the engine's last lines,
 * and the stored engine config carries the deployment's SRT passphrase and its
 * webhook token. Its failures are read in an Actions log, and that file cannot
 * run here, so what proves the assertions is this.
 */
import { AssertionError } from 'node:assert';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { assertMatchesRedacted, assertNull } from '../support/redactedAssertions.js';
import { REDACTED } from '../support/redactEngineOutput.js';

/** A stored engine config, in the shape the SRS template leaves it. */
const PASSPHRASE = 's3cretpassphrase16';
const WEBHOOK_TOKEN = 'a1b2c3d4e5';
const STORED_CONFIG =
  'listen 1935;\n' +
  `    passphrase ${PASSPHRASE};\n` +
  `on_publish http://stream-uploader:3000/engines/srs/streams?token=${WEBHOOK_TOKEN};\n`;

/** Everything the reporter would put in the block, in one string. */
function printedBy(failing: () => void): string {
  try {
    failing();
  } catch (error) {
    if (!(error instanceof AssertionError)) throw error;
    return [
      error.message,
      inspect(error.actual),
      inspect(error.expected),
      String(error.operator),
    ].join('\n');
  }
  throw new Error('the assertion passed, so there is nothing it would have printed');
}

describe('an assertion on the engine tail', () => {
  it('prints the redacted copy and never the raw one', () => {
    const printed = printedBy(() =>
      assertMatchesRedacted(STORED_CONFIG, /nothing here says this/, 'the reason does not say it'),
    );

    assert.equal(printed.includes(PASSPHRASE), false, printed);
    assert.equal(printed.includes(WEBHOOK_TOKEN), false, printed);
    assert.match(printed, new RegExp(REDACTED));
    assert.match(printed, /the reason does not say it/);
  });

  it('still passes on what the tail is actually about, which names no secret', () => {
    assertMatchesRedacted(
      `${STORED_CONFIG}Failed, code=-1 : chdir to /no/such/directory, r0=-1`,
      /no\/such\/directory/,
      'the reason does not carry the engine own last lines',
    );
  });
});

describe('an assertion that a stored config is gone', () => {
  it('prints the answer rather than the config', () => {
    const printed = printedBy(() => assertNull(STORED_CONFIG, 'the template is back'));

    assert.equal(printed.includes(PASSPHRASE), false, printed);
    assert.equal(printed.includes(WEBHOOK_TOKEN), false, printed);
    assert.equal(printed.includes('listen 1935'), false, printed);
    assert.match(printed, /the template is back/);
  });

  it('passes on null and refuses anything else, including undefined', () => {
    assertNull(null, 'null is the answer this one wants');
    assert.throws(() => assertNull(undefined, 'undefined is not null'), AssertionError);
  });
});
