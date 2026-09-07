/**
 * What makes a build directory a build the manager may deploy from.
 *
 * Unit test over a temporary directory. `pnpm test` in manager/.
 *
 * A build carries `.stack-manifest.json`, written by the build script with
 * the commit, the build id, when it was built and with what, and a
 * `.complete` marker written last. A directory with either missing is not a
 * build, whatever else is in it, and a manager that reads a manifest reads
 * it from the build itself, never from a parent directory.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
  buildIdProblem,
  readBuildManifest,
} from '../../src/domain/versions/buildManifest.js';

const MANIFEST = {
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  buildId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  builtAt: '2026-09-08T10:00:00.000Z',
  toolchain: 'node:22-alpine pnpm@9.12.0',
};

function build(over: Partial<Record<keyof typeof MANIFEST, unknown>> = {}, complete = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-manifest-'));
  writeFileSync(join(dir, BUILD_MANIFEST_FILE), JSON.stringify({ ...MANIFEST, ...over }));
  if (complete) writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
  return dir;
}

describe('readBuildManifest', () => {
  it('reads a complete build', () => {
    const read = readBuildManifest(build());

    assert.deepEqual(read, { manifest: MANIFEST, problem: null });
  });

  it('names a missing directory', () => {
    const read = readBuildManifest(join(tmpdir(), 'no-such-build'));

    assert.equal(read.manifest, null);
    assert.match(read.problem ?? '', /no-such-build.*does not exist/);
  });

  it('refuses a build without its complete marker, naming the marker', () => {
    const read = readBuildManifest(build({}, false));

    assert.equal(read.manifest, null);
    assert.match(read.problem ?? '', new RegExp(`${BUILD_COMPLETE_MARKER}`));
  });

  it('refuses a directory without a manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-manifest-'));
    mkdirSync(join(dir, 'deploy'));
    writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');

    const read = readBuildManifest(dir);

    assert.equal(read.manifest, null);
    assert.match(read.problem ?? '', new RegExp(`${BUILD_MANIFEST_FILE}`));
  });

  it('refuses a manifest that does not parse or lacks a field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-manifest-'));
    writeFileSync(join(dir, BUILD_MANIFEST_FILE), '{ not json');
    writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
    assert.match(readBuildManifest(dir).problem ?? '', /does not parse/);

    assert.match(readBuildManifest(build({ commit: undefined })).problem ?? '', /commit/);
    assert.match(readBuildManifest(build({ buildId: 'not a build id' })).problem ?? '', /buildId/);
  });

  it('does not read a manifest from the parent directory', () => {
    const parent = build();
    const child = join(parent, 'deploy');
    mkdirSync(child);

    assert.equal(readBuildManifest(child).manifest, null);
  });
});

describe('buildIdProblem', () => {
  it('accepts a commit and a forced rebuild of it', () => {
    assert.equal(buildIdProblem(MANIFEST.commit), null);
    assert.equal(buildIdProblem(`${MANIFEST.commit}-r2`), null);
    assert.equal(buildIdProblem('abc1234'), null);
  });

  it('refuses anything else, in one sentence', () => {
    assert.match(buildIdProblem('') ?? '', /build id/);
    assert.match(buildIdProblem('../x') ?? '', /build id/);
    assert.match(buildIdProblem('abc1234-r0') ?? '', /build id/);
    assert.match(buildIdProblem('ABC1234') ?? '', /build id/);
  });
});
