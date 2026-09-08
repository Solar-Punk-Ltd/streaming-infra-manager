/**
 * Where a version keeps its clone, its builds and its host-owned inputs.
 *
 * Unit test, no filesystem. `pnpm test` in manager/.
 *
 * The clone is never deployed from, every build is an immutable directory of
 * its own, and the flat root a version had before builds existed stays as the
 * home of the host-owned inputs and, for a legacy row, the artifact. A dot
 * cannot appear in a version name, so the three are siblings and the flat
 * root is never an ancestor of a build.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDirFor,
  buildsRootFor,
  configRootFor,
  repoRootFor,
  stagingDirFor,
  versionRootFor,
} from '../../src/domain/versions/stackPaths.js';

const VERSIONS_ROOT = '/srv/stack-versions';

describe('the layout of a version', () => {
  it('keeps the clone beside the flat root, never inside it', () => {
    assert.equal(repoRootFor(VERSIONS_ROOT, 'main-v3'), '/srv/stack-versions/main-v3.repo');
  });

  it('keeps every build under a sibling of the flat root, one directory per build id', () => {
    assert.equal(buildsRootFor(VERSIONS_ROOT, 'main-v3'), '/srv/stack-versions/main-v3.builds');
    assert.equal(
      buildDirFor(VERSIONS_ROOT, 'main-v3', 'abc1234def5678'),
      '/srv/stack-versions/main-v3.builds/abc1234def5678',
    );
  });

  it('gives every build attempt a staging directory of its own', () => {
    assert.equal(
      stagingDirFor(VERSIONS_ROOT, 'main-v3', 'a7'),
      '/srv/stack-versions/main-v3.builds/tmp-a7',
    );
  });

  it('keeps the host-owned inputs in the flat root a version always had', () => {
    assert.equal(configRootFor(VERSIONS_ROOT, 'main-v3'), versionRootFor(VERSIONS_ROOT, 'main-v3'));
    assert.equal(configRootFor(VERSIONS_ROOT, 'main-v3'), '/srv/stack-versions/main-v3');
  });

  it('refuses a build id that could leave the builds directory', () => {
    for (const bad of ['', '..', 'a/b', '-r1', 'abc.', 'ABC']) {
      assert.throws(() => buildDirFor(VERSIONS_ROOT, 'main-v3', bad), /build id/, bad);
    }
  });
});
