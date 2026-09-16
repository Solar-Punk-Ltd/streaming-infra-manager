/**
 * Every bind key the stack ships is named in the deploy guide.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A *_BIND key takes a published port off every interface and answers on one
 * address instead, which is the whole of the control over APIs that ask for no
 * password. Step 2 of deploy/README.md is where an operator is told to set
 * them, so a key the stack adds and the guide never names is a port left open
 * by a reader who did everything the guide asked: the three engine keys were
 * exactly that until 2026-09-16. The comparison is against the submodule at
 * manager/swarm-hls-stream, which is the checkout this manager deploys. The
 * rung keys are commented out there and stay out of this, because they belong
 * to services the manager never starts.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const STACK_SAMPLE = fileURLToPath(new URL('../../swarm-hls-stream/.env.sample', import.meta.url));
const DEPLOY_GUIDE = fileURLToPath(new URL('../../../deploy/README.md', import.meta.url));

/** A key an operator can set, as the sample writes one: at the start of a line, never behind a #. */
const SETTABLE_BIND_KEY = /^([A-Z0-9_]+_BIND)=/;

function settableBindKeys(sample: string): string[] {
  return sample
    .split('\n')
    .map((line) => SETTABLE_BIND_KEY.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

function stackSample(): string {
  assert.ok(
    existsSync(STACK_SAMPLE),
    `The stack submodule is missing at ${STACK_SAMPLE}, so the guide would be compared against nothing. Run git submodule update --init.`,
  );
  return readFileSync(STACK_SAMPLE, 'utf8');
}

describe('the deploy guide against the bind keys the stack ships', () => {
  it('names every bind key an operator can set', () => {
    const keys = settableBindKeys(stackSample());
    assert.ok(keys.length > 0, 'the sample offers no bind key at all, so the guide is being held to nothing');
    const guide = readFileSync(DEPLOY_GUIDE, 'utf8');
    assert.deepEqual(
      keys.filter((key) => !guide.includes(key)),
      [],
      'these keys bind a port the stack publishes and deploy/README.md never names them, so an operator who follows it leaves them on every interface',
    );
  });
});
