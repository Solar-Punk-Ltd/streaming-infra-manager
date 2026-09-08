import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { captureBundledInputs, exportPinnedBundledSource, type GitReadCommand } from '../../src/domain/versions/bundledSourceCapture.js';
import { commitHostConfig, CONFIG_REVISION_FILE, holdHostConfigLock } from '../../src/domain/versions/hostConfigCapture.js';

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  return { root, source, output: join(root, 'private') };
}

function gitShim(options: { dirty?: string; tree?: string; onResolve?: () => void } = {}) {
  const calls: string[][] = [];
  const run: GitReadCommand = async (_root, args) => {
    calls.push([...args]);
    if (args[0] === 'rev-parse') { options.onResolve?.(); return Buffer.from(COMMIT + '\n'); }
    if (args[0] === 'status') return Buffer.from(options.dirty ?? '');
    if (args[0] === 'ls-tree') {
      assert.equal(args.at(-1), COMMIT, 'tree reads name the selected commit');
      return Buffer.from(options.tree ?? `100644 blob ${OTHER}\tsrc/main.ts\0`);
    }
    if (args[0] === 'cat-file') return Buffer.from('export const builtFrom = "A";\n');
    throw new Error('Unexpected Git command');
  };
  return { run, calls };
}

test('exports object bytes from the one selected commit even if the working tree changes afterward', async () => {
  const { source, output } = await fixture();
  await writeFile(join(source, 'working-only.txt'), 'mutable B');
  let moved = false;
  const git = gitShim({ onResolve: () => { moved = true; } });
  const captured = await exportPinnedBundledSource(source, output, git.run);
  assert.equal(moved, true);
  assert.equal(captured.commit, COMMIT);
  assert.equal(captured.root, output);
  assert.equal(await readFile(join(output, 'src/main.ts'), 'utf8'), 'export const builtFrom = "A";\n');
  await assert.rejects(readFile(join(output, 'working-only.txt')));
  assert.equal(git.calls.filter(([cmd]) => cmd === 'rev-parse').length, 1);
});

for (const path of ['src/main.ts', '.env.sample', 'deploy/config.json.sample', 'untracked.txt']) {
  test(`refuses dirty application path ${path} before exporting`, async () => {
    const { source, output } = await fixture();
    const git = gitShim({ dirty: ` M ${path}\0` });
    await assert.rejects(exportPinnedBundledSource(source, output, git.run), /application.*changes/i);
    assert.equal(git.calls.some(([cmd]) => cmd === 'cat-file'), false);
    await assert.rejects(readFile(join(output, 'src/main.ts')));
  });
}

test('allows only the laptop-owned input changes while exporting committed application files', async () => {
  const { source, output } = await fixture();
  const git = gitShim({ dirty: ' M .env\0 M deploy/config.json\0?? engines/srs/.env\0?? .config-revision.json\0' });
  await exportPinnedBundledSource(source, output, git.run);
  assert.equal(await readFile(join(output, 'src/main.ts'), 'utf8'), 'export const builtFrom = "A";\n');
});

test('rename status checks both the old and new application paths', async () => {
  const { source, output } = await fixture();
  const git = gitShim({ dirty: 'R  .env\0src/main.ts\0' });
  await assert.rejects(exportPinnedBundledSource(source, output, git.run), /application.*changes/i);
});

for (const path of ['../outside', '/absolute', 'src/../../outside']) {
  test(`refuses an exported tree path that escapes: ${path}`, async () => {
    const { source, output } = await fixture();
    const git = gitShim({ tree: `100644 blob ${OTHER}\t${path}\0` });
    await assert.rejects(exportPinnedBundledSource(source, output, git.run), /path/i);
  });
}

test('does not overwrite an existing destination', async () => {
  const { source, output } = await fixture();
  await mkdir(output);
  await writeFile(join(output, 'keep'), 'owned by another attempt');
  await assert.rejects(exportPinnedBundledSource(source, output, gitShim().run), /exist/i);
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'owned by another attempt');
});

test('exports a gitlink from its recorded commit without using its moving HEAD', async () => {
  const { source, output } = await fixture();
  await mkdir(join(source, 'library'));
  const run: GitReadCommand = async (cwd, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(COMMIT + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree' && cwd === source) return Buffer.from(`160000 commit ${OTHER}\tlibrary\0`);
    if (args[0] === 'ls-tree') {
      assert.equal(cwd, join(source, 'library'));
      assert.equal(args.at(-1), OTHER);
      return Buffer.from(`100644 blob ${COMMIT}\tlibrary.ts\0`);
    }
    if (args[0] === 'cat-file') return Buffer.from('pinned library');
    throw new Error('Unexpected command');
  };
  await exportPinnedBundledSource(source, output, run);
  assert.equal(await readFile(join(output, 'library/library.ts'), 'utf8'), 'pinned library');
});

test('private capture uses one committed input revision and removes absent committed defaults', async () => {
  const { source, output } = await fixture();
  await mkdir(join(output, 'engines', 'old'), { recursive: true });
  await writeFile(join(output, 'engines', 'old', '.env'), 'OLD=default\n');
  await writeFile(join(output, '.env.sample'), 'ENGINE=sample\n');
  const revision = await commitHostConfig(source, {
    '.env': Buffer.from('ENGINE=laptop\n'),
    'deploy/config.json': Buffer.from('{"revision":"A"}\n'),
  });
  const captured = await captureBundledInputs(source, output);
  assert.equal(captured.generation, revision.generation);
  assert.deepEqual(captured.hashes, revision.files);
  assert.equal(await readFile(join(output, '.env'), 'utf8'), 'ENGINE=laptop\n');
  await assert.rejects(readFile(join(output, 'engines/old/.env')));
  await commitHostConfig(source, { '.env': Buffer.from('ENGINE=later\n') });
  assert.equal(await readFile(join(output, '.env'), 'utf8'), 'ENGINE=laptop\n');
});

test('capture waits for the revision lock and refuses an uncommitted mixed set', async () => {
  const { source, output } = await fixture();
  await mkdir(output);
  await commitHostConfig(source, { '.env': Buffer.from('ENGINE=A\n') });
  const release = await holdHostConfigLock(source);
  try {
    await writeFile(join(source, '.env'), 'ENGINE=B\n');
    await assert.rejects(captureBundledInputs(source, output, { lockWaitMs: 5 }), /being edited/);
  } finally { await release(); }
  await assert.rejects(captureBundledInputs(source, output), /committed revision/i);
  await assert.rejects(readFile(join(output, '.env')));
});

test('requires explicit adoption of a legacy input set instead of inventing its revision', async () => {
  const { source, output } = await fixture();
  await mkdir(output);
  await writeFile(join(source, '.env'), 'ENGINE=A\n');
  await assert.rejects(captureBundledInputs(source, output), /committed revision/i);
});

for (const path of ['../outside', '/absolute', 'application.ts']) {
  test(`refuses non-input revision path ${path} before reading it`, async () => {
    const { source, output } = await fixture();
    await mkdir(output);
    await writeFile(join(source, CONFIG_REVISION_FILE), JSON.stringify({ generation: 1, files: { [path]: 'a'.repeat(64) } }));
    await assert.rejects(captureBundledInputs(source, output), /input path/i);
  });
}

test('refuses source and destination symlinks without following them outside ownership', async () => {
  const { root, source, output } = await fixture();
  await mkdir(output);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, '.env'), 'OUTSIDE=untouched\n');
  await commitHostConfig(source, { 'engines/srs/.env': Buffer.from('ENGINE=A\n') });
  await rm(join(source, 'engines/srs'), { recursive: true });
  await symlink(outside, join(source, 'engines/srs'));
  await assert.rejects(captureBundledInputs(source, output), /symbolic|symlink/i);
  await rm(join(source, 'engines/srs'));
  await commitHostConfig(source, { 'engines/srs/.env': Buffer.from('ENGINE=A\n') });
  await symlink(outside, join(output, 'engines'));
  await assert.rejects(captureBundledInputs(source, output), /symbolic|symlink/i);
  assert.equal(await readFile(join(outside, '.env'), 'utf8'), 'OUTSIDE=untouched\n');
});

test('refuses a symlink at the private revision manifest before replacing inputs', async () => {
  const { root, source, output } = await fixture();
  await mkdir(output);
  const outside = join(root, 'outside');
  await writeFile(outside, 'untouched');
  await symlink(outside, join(output, CONFIG_REVISION_FILE));
  await commitHostConfig(source, { '.env': Buffer.from('ENGINE=A\n') });
  await assert.rejects(captureBundledInputs(source, output), /symbolic|symlink/i);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  await assert.rejects(readFile(join(output, '.env')));
});

test('never captures inputs back over the source tree', async () => {
  const { source } = await fixture();
  await commitHostConfig(source, { '.env': Buffer.from('ENGINE=A\n') });
  await assert.rejects(captureBundledInputs(source, source), /separate/);
  assert.equal(await readFile(join(source, '.env'), 'utf8'), 'ENGINE=A\n');
});

test('rejects source/destination aliasing through an ancestor symlink', async () => {
  const { root, source } = await fixture();
  await commitHostConfig(source, { '.env': Buffer.from('ENGINE=A\n') });
  await symlink(root, join(root, 'alias'));
  await assert.rejects(captureBundledInputs(source, join(root, 'alias', 'source')), /separate/);
  assert.equal(await readFile(join(source, '.env'), 'utf8'), 'ENGINE=A\n');
});

test('preserves executable files and internal links without reading a working-tree target', async () => {
  const { source, output } = await fixture();
  const run: GitReadCommand = async (_root, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(COMMIT + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from(`100755 blob ${COMMIT}\trun.sh\0` + `120000 blob ${OTHER}\tbin/run\0`);
    if (args[0] === 'cat-file') return Buffer.from(args[2] === COMMIT ? '#!/bin/sh\n' : '../run.sh');
    throw new Error('Unexpected command');
  };
  await exportPinnedBundledSource(source, output, run);
  assert.equal((await lstat(join(output, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(output, 'bin/run')), '../run.sh');
});

test('refuses an escaping Git symlink and removes only its failed private export', async () => {
  const { source, output } = await fixture();
  const run: GitReadCommand = async (_root, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(COMMIT + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from(`120000 blob ${OTHER}\tescape\0`);
    return Buffer.from('../../outside');
  };
  await assert.rejects(exportPinnedBundledSource(source, output, run), /escapes/);
  await assert.rejects(lstat(output));
  assert.equal((await lstat(source)).isDirectory(), true);
});

test('rejects a composed link escape whose individual targets are lexically inside', async () => {
  const { root, source, output } = await fixture();
  await writeFile(join(root, 'outside.txt'), 'sibling sentinel');
  const run: GitReadCommand = async (_root, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(COMMIT + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from(`120000 blob ${COMMIT}\ta\0` + `120000 blob ${OTHER}\tb\0`);
    return Buffer.from(args[2] === COMMIT ? '.' : 'a/../outside.txt');
  };
  await assert.rejects(exportPinnedBundledSource(source, output, run), /escapes/);
  await assert.rejects(lstat(output));
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'sibling sentinel');
});

test('allows an internal composed link after expanding its intermediate target', async () => {
  const { source, output } = await fixture();
  const fileId = 'c'.repeat(40);
  const run: GitReadCommand = async (_root, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(COMMIT + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from(`120000 blob ${COMMIT}\ta\0` + `120000 blob ${OTHER}\tb\0` + `100644 blob ${fileId}\tinside.txt\0`);
    return Buffer.from(args[2] === COMMIT ? '.' : args[2] === OTHER ? 'a/inside.txt' : 'internal sentinel');
  };
  await exportPinnedBundledSource(source, output, run);
  assert.equal(await readFile(join(output, 'b'), 'utf8'), 'internal sentinel');
});
