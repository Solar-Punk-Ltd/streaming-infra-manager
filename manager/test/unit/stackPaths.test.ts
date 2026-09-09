/**
 * Where a deployment's scripts, env files and samples come from.
 *
 * Unit test, nothing touched on disk. `pnpm test` in manager/.
 *
 * One root decides all of them, so moving a deployment to another version is a
 * different root and nothing else. A null root_path is the bundled checkout,
 * because only the running manager knows where that is and a migration cannot
 * write it down.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  stackPaths,
  stackRootOf,
  deployRootProblem,
  versionRootFor,
} from '../../src/domain/versions/stackPaths.js';
import { BUNDLED_STACK_ROOT } from '../../src/utils/envUtils.js';

const VERSIONS_ROOT = '/synthetic-main-v2-stack-versions';
const ADDED_ROOT = join(VERSIONS_ROOT, 'main-v3');

describe('stackPaths for the bundled version', () => {
  const paths = stackPaths({ rootPath: null });

  it('resolves the checkout the manager ships with', () => {
    assert.equal(stackRootOf({ rootPath: null }), BUNDLED_STACK_ROOT);
    assert.equal(paths.root, BUNDLED_STACK_ROOT);
  });

  it('finds the four deploy scripts under it', () => {
    const scripts = join(BUNDLED_STACK_ROOT, 'deploy', 'scripts');
    assert.equal(paths.deploy, join(scripts, 'deploy.sh'));
    assert.equal(paths.stop, join(scripts, 'stop.sh'));
    assert.equal(paths.clean, join(scripts, 'clean.sh'));
    assert.equal(paths.health, join(scripts, 'health.sh'));
  });

  it('names the base env and one env file per deployment', () => {
    assert.equal(paths.baseEnv, join(BUNDLED_STACK_ROOT, '.env'));
    assert.equal(
      paths.envFile('main-stage'),
      join(BUNDLED_STACK_ROOT, '.env.main-stage'),
    );
  });

  it('carries the samples a fresh checkout has to be given', () => {
    assert.deepEqual(paths.bootstrapPairs, [
      {
        src: join(BUNDLED_STACK_ROOT, '.env.sample'),
        dst: join(BUNDLED_STACK_ROOT, '.env'),
      },
      {
        src: join(BUNDLED_STACK_ROOT, 'deploy', 'config.sample.json'),
        dst: join(BUNDLED_STACK_ROOT, 'deploy', 'config.json'),
      },
    ]);
  });
});

describe('stackPaths for an added version', () => {
  const paths = stackPaths({ rootPath: ADDED_ROOT });

  it('takes every path from the root of that version', () => {
    assert.equal(paths.root, ADDED_ROOT);
    assert.equal(
      paths.deploy,
      join(ADDED_ROOT, 'deploy', 'scripts', 'deploy.sh'),
    );
    assert.equal(
      paths.envFile('main-stage'),
      join(ADDED_ROOT, '.env.main-stage'),
    );
    assert.equal(paths.bootstrapPairs[0]?.dst, join(ADDED_ROOT, '.env'));
  });

  it('shares nothing with the bundled checkout', () => {
    const bundled = stackPaths({ rootPath: null });
    assert.notEqual(paths.deploy, bundled.deploy);
    assert.notEqual(paths.envFile('main-stage'), bundled.envFile('main-stage'));
  });
});

describe('versionRootFor', () => {
  it('gives each version one directory under the versions root', () => {
    assert.equal(versionRootFor(VERSIONS_ROOT, 'main-v3'), ADDED_ROOT);
  });
});

describe('incomplete immutable build rows', () => {
  for (const buildId of ['a'.repeat(40), null]) {
    it(`does not resolve a builds row without a root to bundled, build ${buildId ?? 'unset'}`, () => {
      const version = { rootPath: null, layout: 'builds' as const, buildId };
      assert.match(deployRootProblem(version) ?? '', /artifact root/);
      assert.throws(() => stackRootOf(version), /artifact root/);
    });
  }

  it('does not resolve a builds row without a build id to the legacy root', () => {
    const version = { rootPath: ADDED_ROOT, layout: 'builds' as const, buildId: null };
    assert.match(deployRootProblem(version) ?? '', /no build/);
    assert.throws(() => stackRootOf(version), /no build/);
  });

  it('resolves a published bundled build from its explicit artifact root', () => {
    const buildId = 'a'.repeat(40);
    assert.equal(stackRootOf({ rootPath: join(VERSIONS_ROOT, 'bundled'), layout: 'builds', buildId }), join(VERSIONS_ROOT, 'bundled.builds', buildId));
  });
});
