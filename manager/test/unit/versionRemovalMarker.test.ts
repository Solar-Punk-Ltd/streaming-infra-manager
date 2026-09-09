import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { deployRootProblem } from '../../src/domain/versions/stackPaths.js';

const BUILD = 'a'.repeat(40);
describe('persistent removal markers at deployment admission', () => {
  let root: string;
  let anchor: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04a-removal-marker-'));
    anchor = join(root, 'test-stack');
    path = `${anchor}.removal.json`;
    const artifact = join(root, 'test-stack.builds', BUILD);
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, '.complete'), '');
    await writeFile(join(artifact, '.stack-manifest.json'), JSON.stringify({ buildId: BUILD, commit: BUILD, builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic' }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const identity = () => ({ schema: 1, versionId: 2, name: 'test-stack', rootPath: anchor, removalId: randomUUID() });
  for (const layout of ['legacy', 'builds'] as const) {
    const version = () => ({ id: 2, rootPath: anchor, layout, buildId: BUILD });
    it(`${layout} refuses a marked version even with complete and manifest intact`, async () => {
      assert.equal(deployRootProblem(version()), null);
      await writeFile(path, JSON.stringify(identity()));
      assert.match(deployRootProblem(version()) ?? '', /removal/i);
    });
    it(`${layout} permits same-name reuse only for a well-formed older version tombstone`, async () => {
      await writeFile(path, JSON.stringify({ ...identity(), versionId: 1 }));
      assert.equal(deployRootProblem(version()), null);
    });
    for (const bad of ['schema', 'name', 'anchor', 'id', 'uuid', 'extra', 'json', 'oversize']) {
      it(`${layout} refuses ${bad} marker evidence rather than treating it as a retired ID`, async () => {
        const value = { ...identity(), versionId: 1 };
        const wrong = { schema: { ...value, schema: 2 }, name: { ...value, name: 'other' }, anchor: { ...value, rootPath: join(root, 'other') }, id: { ...value, versionId: -1 }, uuid: { ...value, removalId: 'bad' }, extra: { ...value, ignored: true }, json: null, oversize: null }[bad];
        await writeFile(path, bad === 'json' ? '{' : bad === 'oversize' ? ' '.repeat(5000) : JSON.stringify(wrong));
        assert.match(deployRootProblem(version()) ?? '', /removal/i);
      });
    }
    it(`${layout} refuses missing caller identity when a valid tombstone exists`, async () => {
      await writeFile(path, JSON.stringify(identity()));
      assert.match(deployRootProblem({ rootPath: anchor, layout, buildId: BUILD }) ?? '', /removal/i);
    });
    for (const target of ['existing', 'missing']) {
      it(`${layout} refuses a ${target} marker symlink`, async () => {
        const outside = join(root, 'other-file');
        if (target === 'existing') await writeFile(outside, JSON.stringify({ ...identity(), versionId: 1 }));
        await symlink(outside, path);
        assert.match(deployRootProblem(version()) ?? '', /removal/i);
      });
    }
    it(`${layout} refuses a directory at the marker path`, async () => {
      await mkdir(path);
      assert.match(deployRootProblem(version()) ?? '', /removal/i);
    });
  }
});
