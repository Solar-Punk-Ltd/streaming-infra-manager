/**
 * The unit suite never runs on the checkout this manager ships with.
 *
 * A deployment writes an env file into the root of the stack checkout it
 * deploys, and envUtils reads that root out of SHLS_ROOT once, when it is
 * first imported. So a unit file that sets the variable after an import that
 * reaches envUtils, directly or through a harness, silently deploys into
 * manager/swarm-hls-stream and leaves a .env.<profile> there, merged from the
 * developer's own .env and mode 0600. That happened, it was invisible for the
 * length of the slice, and remembering to import dynamically is not a control.
 *
 * test/unit/run.mjs is the control: it gives the whole run a stack root of its
 * own and removes it afterwards. This file is what refuses when the run went
 * around it. `pnpm test` in manager/, or `node test/unit/run.mjs`.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLACEHOLDER_DATABASE_URL,
  STACK_ROOT_VARIABLE,
  UNIT_ARGS,
  runProblem,
  sandboxedEnv,
} from './run.mjs';

import { BUNDLED_STACK_ROOT } from '../../src/utils/envUtils.js';

const here = dirname(fileURLToPath(import.meta.url));
const shippedCheckout = resolve(here, '..', '..', 'swarm-hls-stream');
const throughTheRunner = `Run the unit suite through pnpm test, which gives it a stack root of its own.`;

describe('the stack root this suite deploys into', () => {
  it('is named by the environment, so nothing falls back to the shipped checkout', () => {
    assert.ok(process.env[STACK_ROOT_VARIABLE], `${STACK_ROOT_VARIABLE} is not set. ${throughTheRunner}`);
  });

  it('is not the checkout this manager ships with', () => {
    assert.notEqual(
      BUNDLED_STACK_ROOT,
      shippedCheckout,
      `This run deploys into ${shippedCheckout}, the real submodule. ${throughTheRunner}`,
    );
  });
});

describe('the runner that hands it that root', () => {
  it('replaces a root the caller exported, and keeps the rest of the environment', () => {
    const env = sandboxedEnv({ [STACK_ROOT_VARIABLE]: '/somewhere/real', DATABASE_URL: 'postgres://unused' }, '/tmp/throwaway');
    assert.equal(env[STACK_ROOT_VARIABLE], '/tmp/throwaway');
    assert.equal(env.DATABASE_URL, 'postgres://unused');
  });

  it('names a database nothing opens, because the config module requires one at load', () => {
    const env = sandboxedEnv({}, '/tmp/throwaway');
    assert.equal(env.DATABASE_URL, PLACEHOLDER_DATABASE_URL);
    assert.match(env.DATABASE_URL, /unused/);
  });

  it('runs the unit glob and nothing else', () => {
    assert.ok(UNIT_ARGS.includes('test/unit/**/*.test.ts'), UNIT_ARGS.join(' '));
    assert.ok(UNIT_ARGS.includes('--conditions=development'), UNIT_ARGS.join(' '));
  });

  it('passes a clean run and refuses a failed or killed one, in words', () => {
    assert.equal(runProblem({ code: 0, signal: null }), null);
    assert.match(runProblem({ code: 1, signal: null }) ?? '', /exited with code 1/);
    assert.match(runProblem({ code: null, signal: 'SIGKILL' }) ?? '', /SIGKILL/);
  });
});
