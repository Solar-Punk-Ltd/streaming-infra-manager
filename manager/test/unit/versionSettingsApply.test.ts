/**
 * Applying a version's saved settings without building the stack again.
 *
 * Unit test over the real router with an in-memory table and a script runner
 * that spawns nothing. `pnpm test` in manager/.
 *
 * A saved setting reaches a new deployment only through a build that captured
 * it, and a full fetch and `pnpm -r build` takes minutes for an edit that
 * changed one line. So apply makes another build of the same commit: the
 * current build's tree with the settings files replaced. Builds stay
 * immutable, which is why this makes a new directory rather than writing into
 * the one deployments are already running from, and the unchanged files are
 * hard links because a build is never written to once it is published.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import { scratchVersionsRoot, V3_FIXTURE } from '../support/stackFixtures.js';
import {
  nextVersionChange,
  startVersionsTestApp,
  type VersionsTestApp,
} from '../support/versionsTestApp.js';

const APPLY_COMMIT = 'be440d65e0e82bcf9000a8a0dde905dc215255d6';

const HOST_BASE_ENV = ['# The token this host was given.', 'API_AUTH_TOKEN=host-token', ''].join('\n');
const HOST_ENGINE_ENV = 'SRT_PASSPHRASE=host-passphrase\n';

let app: VersionsTestApp;
let versionsRoot: string;
let configRoot: string;
let buildsRoot: string;

beforeEach(async () => {
  versionsRoot = scratchVersionsRoot();
  configRoot = join(versionsRoot, 'v3');
  buildsRoot = join(versionsRoot, 'v3.builds');
  app = await startVersionsTestApp(versionsRoot);
});

afterEach(() => app.close());

/** What the build script leaves in staging, plus a link the tree must not be flattened through. */
function builtInStaging(args: string[]): void {
  const staging = args[1] ?? '';
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${APPLY_COMMIT}\n`);
  symlinkSync('deploy/scripts/deploy.sh', join(staging, 'run-deploy'));
}

function seedHostFiles(): void {
  writeFileSync(join(configRoot, '.env'), HOST_BASE_ENV);
  mkdirSync(join(configRoot, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(configRoot, 'engines', 'srs', '.env'), HOST_ENGINE_ENV);
}

interface JsonAnswer {
  status: number;
  body: unknown;
}

async function callJson(method: string, path: string, body?: unknown): Promise<JsonAnswer> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Resolves once the service has spawned `count` build scripts, so the mutex is taken. */
async function untilSpawned(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && app.runner.spawned.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(app.runner.spawned.length, count, 'the build should have been spawned');
}

async function versionRow(name: string): Promise<StackVersion> {
  const rows = (await callJson('GET', '/versions')).body as StackVersion[];
  return rows.find((row) => row.name === name)!;
}

async function buildV3(): Promise<number> {
  const settled = nextVersionChange(app);
  const res = await fetch(`${app.url}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'v3', ref: 'main-v3' }),
  });
  builtInStaging(app.runner.last.args);
  app.runner.finish(0, 'built\n');
  await res.text();
  await settled;
  return (await versionRow('v3')).id;
}

/** Saves one base env key and one engine key, and answers the applied build id. */
async function saveAndApply(id: number, generation: number): Promise<JsonAnswer> {
  const saved = await callJson('PUT', `/versions/${id}/settings`, {
    expectedGeneration: generation,
    files: [
      { path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value: 'a'.repeat(64) }] },
      { path: 'engines/srs/.env', entries: [{ key: 'SRS_SRT_PORT', value: '10099' }] },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return callJson('POST', `/versions/${id}/settings/apply`);
}

function manifestOf(buildId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(buildsRoot, buildId, '.stack-manifest.json'), 'utf8'));
}

describe('POST /versions/:id/settings/apply', () => {
  it('publishes another build of the same commit and keeps the old one as previous', async () => {
    seedHostFiles();
    const id = await buildV3();

    const answer = await saveAndApply(id, 2);
    const row = await versionRow('v3');

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { buildId: `${APPLY_COMMIT}-r1` });
    assert.equal(row.buildId, `${APPLY_COMMIT}-r1`);
    assert.equal(row.previousBuildId, APPLY_COMMIT);
    assert.equal(row.commitSha, APPLY_COMMIT);
    assert.equal(row.status, 'ready');
  });

  it('puts the saved settings in the new build and leaves the old build alone', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(buildsRoot, APPLY_COMMIT, '.env'), 'utf8');

    await saveAndApply(id, 2);

    const applied = join(buildsRoot, `${APPLY_COMMIT}-r1`);
    assert.match(readFileSync(join(applied, '.env'), 'utf8'), new RegExp(`API_AUTH_TOKEN=${'a'.repeat(64)}`));
    assert.match(readFileSync(join(applied, 'engines', 'srs', '.env'), 'utf8'), /^SRS_SRT_PORT=10099$/m);
    assert.equal(readFileSync(join(buildsRoot, APPLY_COMMIT, '.env'), 'utf8'), before);
    assert.equal(before.includes('a'.repeat(64)), false);
  });

  it('shares the unchanged files with the old build and never the settings files', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);

    const inode = (build: string, relative: string): number =>
      statSync(join(buildsRoot, build, relative)).ino;
    const applied = `${APPLY_COMMIT}-r1`;
    for (const shared of ['deploy/scripts/deploy.sh', 'deploy/docker-compose.yml', '.env.sample']) {
      assert.equal(inode(applied, shared), inode(APPLY_COMMIT, shared), shared);
    }
    for (const own of ['.env', 'engines/srs/.env', '.stack-manifest.json', '.complete']) {
      assert.notEqual(inode(applied, own), inode(APPLY_COMMIT, own), own);
    }
  });

  it('recreates a link of the old tree as a link rather than following it', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);

    const link = join(buildsRoot, `${APPLY_COMMIT}-r1`, 'run-deploy');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), 'deploy/scripts/deploy.sh');
  });

  it('keeps the commit and the toolchain and records the settings it captured', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = manifestOf(APPLY_COMMIT);

    await saveAndApply(id, 2);
    const after = manifestOf(`${APPLY_COMMIT}-r1`);

    assert.equal(after.commit, before.commit);
    assert.equal(after.toolchain, before.toolchain);
    assert.equal(after.buildId, `${APPLY_COMMIT}-r1`);
    assert.equal(after.inputGeneration, 3);
    assert.equal(before.inputGeneration, 2);
    assert.equal(after.treeSharing, 'linked');
    assert.notEqual(after.builtAt, before.builtAt);
    assert.match(String(after.builtAt), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('records the hashes of the revision it applied, not the ones the build had', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = manifestOf(APPLY_COMMIT).inputHashes as Record<string, string>;

    await saveAndApply(id, 2);
    const after = manifestOf(`${APPLY_COMMIT}-r1`).inputHashes as Record<string, string>;

    assert.deepEqual(Object.keys(after).sort(), ['.env', 'engines/ome/.env', 'engines/srs/.env']);
    assert.notEqual(after['.env'], before['.env']);
    assert.notEqual(after['engines/srs/.env'], before['engines/srs/.env']);
  });

  it('writes the settings of the new build owner only', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);

    const applied = join(buildsRoot, `${APPLY_COMMIT}-r1`);
    for (const relative of ['.env', 'engines/srs/.env', 'engines/ome/.env']) {
      assert.equal((statSync(join(applied, relative)).mode & 0o777).toString(8), '600', relative);
    }
  });

  it('writes a settings file the build it was made from never had owner only', async () => {
    seedHostFiles();
    const id = await buildV3();
    writeFileSync(join(configRoot, 'deploy', 'config.json'), '{"services":["srs"]}\n');

    await saveAndApply(id, 2);

    const applied = join(buildsRoot, `${APPLY_COMMIT}-r1`);
    assert.equal(existsSync(join(buildsRoot, APPLY_COMMIT, 'deploy', 'config.json')), false);
    assert.equal((statSync(join(applied, 'deploy', 'config.json')).mode & 0o777).toString(8), '600');
  });

  it('prunes the builds nothing protects', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);
    await saveAndApply(id, 3);

    assert.deepEqual(readdirSync(buildsRoot).sort(), [
      `${APPLY_COMMIT}-r1`,
      `${APPLY_COMMIT}-r2`,
    ]);
  });

  it('refuses while another build of this manager is running', async () => {
    seedHostFiles();
    const id = await buildV3();
    const settled = nextVersionChange(app);
    const update = fetch(`${app.url}/versions/${id}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await untilSpawned(2);

    const answer = await callJson('POST', `/versions/${id}/settings/apply`);

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'stack_build_busy');
    assert.equal((answer.body as { name: string }).name, 'v3');
    builtInStaging(app.runner.last.args);
    app.runner.finish(0, 'built\n');
    await (await update).text();
    await settled;
  });

  it('refuses a version whose first build has not happened', async () => {
    const rows = (await callJson('GET', '/versions')).body as StackVersion[];
    const bundled = rows.find((row) => row.name === 'bundled')!;

    const answer = await callJson('POST', `/versions/${bundled.id}/settings/apply`);

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'settings_not_ready');
  });

  it('leaves the mutex free for the next build after it has run', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);
    const second = await saveAndApply(id, 3);

    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { buildId: `${APPLY_COMMIT}-r2` });
  });

  it('leaves no staging directory behind', async () => {
    seedHostFiles();
    const id = await buildV3();

    await saveAndApply(id, 2);

    assert.deepEqual(readdirSync(buildsRoot).filter((entry) => entry.startsWith('tmp-')), []);
  });
});
