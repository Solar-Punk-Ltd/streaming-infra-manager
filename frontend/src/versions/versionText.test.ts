/**
 * What the Versions page says about a version in words.
 *
 * Unit test over the text helpers alone, with no rendering. `pnpm test` in
 * frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import { describeBuild, describeVersion, updateHint } from './versionText';

const COMMIT = 'ee99c368bd45c12defcb10ca726f0db0777defb0';

function version(over: Partial<StackVersion> = {}): StackVersion {
  return {
    id: 1,
    name: 'bundled',
    gitRef: COMMIT,
    commitSha: COMMIT,
    status: 'ready',
    isDefault: true,
    tested: true,
    testedInvalidatedAt: null,
    builtAt: '2026-09-09T10:00:00.000Z',
    lastError: null,
    contract: null,
    deployments: 0,
    layout: 'builds',
    buildId: COMMIT,
    previousBuildId: null,
    ...over,
  };
}

describe('what Update does on a card', () => {
  it('says the bundled version is rebuilt from the commit the manager ships with', () => {
    assert.equal(updateHint(version()), 'Rebuild the version the manager ships with, commit ee99c36.');
  });

  it('says so without a commit when this host cannot tell which one that is', () => {
    assert.match(updateHint(version({ commitSha: null })), /^Rebuild the version the manager ships with\./);
    assert.match(updateHint(version({ commitSha: null })), /cannot tell/);
  });

  it('says nothing for a version an operator added, whose branch the button already names', () => {
    assert.equal(updateHint(version({ name: 'review-stack', gitRef: 'main-v3' })), '');
  });
});

describe('where a version deploys from', () => {
  it('names the build of a version that has one', () => {
    assert.equal(describeBuild(version()), 'build ee99c36');
  });

  it('says the bundled version runs the tree the manager shipped until it is built here', () => {
    assert.equal(describeBuild(version({ layout: 'legacy', buildId: null })), 'with the manager, legacy tree');
  });

  it('names a version and its commit', () => {
    assert.equal(describeVersion(version()), 'bundled @ ee99c36');
  });
});
