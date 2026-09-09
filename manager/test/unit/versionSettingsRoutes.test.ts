/**
 * What the settings routes of one version answer.
 *
 * Unit test over the real router with an in-memory table and a script runner
 * that spawns nothing. `pnpm test` in manager/.
 *
 * A version's settings are three kinds of file the operator owns: the base
 * `.env`, `deploy/config.json` and one `.env` per engine. They live beside the
 * checkout, a build copies the revision current when it published into its own
 * tree, and until now the only way to change one was the editing script over
 * ssh. These routes are the page's way in, and what they must not do is lose a
 * byte of a file somebody has been maintaining by hand.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  StackSettings,
  StackSettingsEnvFile,
  StackSettingsEntry,
  StackSettingsJsonFile,
} from '@streaming-infra-manager/common';

import { scratchVersionsRoot, V3_FIXTURE } from '../support/stackFixtures.js';
import {
  nextVersionChange,
  startVersionsTestApp,
  type VersionsTestApp,
} from '../support/versionsTestApp.js';

const ROUTE_COMMIT = 'be440d65e0e82bcf9000a8a0dde905dc215255d6';

/** The sample of the deploy config, which the cut-down fixture does not carry. */
const CONFIG_SAMPLE = '{\n  "services": []\n}\n';

/** The operator's own base env: one key set by hand, one the sample never had. */
const HOST_BASE_ENV = [
  '# The token this host was given.',
  'API_AUTH_TOKEN=host-token',
  '',
  'EXTRA_LOCAL_KEY=kept',
  '',
].join('\n');

const HOST_ENGINE_ENV = 'SRT_PASSPHRASE=host-passphrase\n';
const HOST_DEPLOY_CONFIG = '{\n  "services": ["srs"]\n}\n';

let app: VersionsTestApp;
let versionsRoot: string;
let configRoot: string;

beforeEach(async () => {
  versionsRoot = scratchVersionsRoot();
  configRoot = join(versionsRoot, 'v3');
  app = await startVersionsTestApp(versionsRoot);
});

afterEach(() => app.close());

/** What the build script leaves in staging, plus the deploy config sample the page resets to. */
function builtInStaging(args: string[]): void {
  const staging = args[1] ?? '';
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${ROUTE_COMMIT}\n`);
  writeFileSync(join(staging, 'deploy', 'config.sample.json'), CONFIG_SAMPLE);
}

/** The files an operator already keeps in the version's config root, before its first build. */
function seedHostFiles(): void {
  writeFileSync(join(configRoot, '.env'), HOST_BASE_ENV);
  mkdirSync(join(configRoot, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(configRoot, 'engines', 'srs', '.env'), HOST_ENGINE_ENV);
  writeFileSync(join(configRoot, 'deploy', 'config.json'), HOST_DEPLOY_CONFIG);
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

/** Adds and builds `v3`, and answers its id. */
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
  const rows = (await callJson('GET', '/versions')).body as { id: number; name: string }[];
  return rows.find((row) => row.name === 'v3')!.id;
}

async function bundledId(): Promise<number> {
  const rows = (await callJson('GET', '/versions')).body as { id: number; name: string }[];
  return rows.find((row) => row.name === 'bundled')!.id;
}

function envFileAt(settings: StackSettings, path: string): StackSettingsEnvFile {
  const file = settings.files.find((entry) => entry.path === path);
  assert.ok(file && file.kind === 'env', `${path} should be an env file`);
  return file;
}

function entryFor(file: StackSettingsEnvFile, key: string): StackSettingsEntry {
  const entry = file.entries.find((candidate) => candidate.key === key);
  assert.ok(entry, `${file.path} should carry ${key}`);
  return entry;
}

describe('GET /versions/:id/settings', () => {
  it('answers the operator files of the version, base env first', async () => {
    seedHostFiles();
    const id = await buildV3();

    const answer = await callJson('GET', `/versions/${id}/settings`);
    const settings = answer.body as StackSettings;

    assert.equal(answer.status, 200);
    assert.deepEqual(settings.files.map((file) => file.path), [
      '.env',
      'deploy/config.json',
      'engines/srs/.env',
    ]);
    assert.equal(settings.generation, 2);
    assert.equal(settings.buildId, ROUTE_COMMIT);
  });

  it('orders the entries the way the version declares them, the file extras last', async () => {
    seedHostFiles();
    const id = await buildV3();

    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;

    assert.deepEqual(envFileAt(settings, '.env').entries.map((entry) => entry.key), [
      'STAMP',
      'STREAM_KEY',
      'STREAM_LIST_TOPIC',
      'API_AUTH_TOKEN',
      'PUBLISH_KEY_SECRET',
      'CHEQUEBOOK_MIN_BZZ',
      'STAMP_MIN_TTL_HOURS',
      'STAMP_MAX_UTILIZATION',
      'API_PORT',
      'ENGINE',
      'BEE_UPLOADER_API_PORT',
      'BEE_GATEWAY_API_PORT',
      'EXTRA_LOCAL_KEY',
    ]);
  });

  it('describes a key from the comment block the sample keeps above it', async () => {
    seedHostFiles();
    const id = await buildV3();

    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;
    const token = entryFor(envFileAt(settings, '.env'), 'API_AUTH_TOKEN');

    assert.match(token.description, /^Bearer token for every gated route\./);
    assert.match(token.description, /Generate one with:  openssl rand -hex 32$/);
    assert.equal(entryFor(envFileAt(settings, '.env'), 'API_PORT').description, '');
  });

  it('answers the host value and the sample value side by side', async () => {
    seedHostFiles();
    const id = await buildV3();

    const base = envFileAt((await callJson('GET', `/versions/${id}/settings`)).body as StackSettings, '.env');

    assert.deepEqual(entryFor(base, 'API_AUTH_TOKEN').value, 'host-token');
    assert.deepEqual(entryFor(base, 'API_AUTH_TOKEN').sampleValue, '');
    assert.deepEqual(entryFor(base, 'API_PORT').value, '3000');
    assert.deepEqual(entryFor(base, 'API_PORT').sampleValue, '3000');
    assert.deepEqual(entryFor(base, 'EXTRA_LOCAL_KEY').value, 'kept');
    assert.deepEqual(entryFor(base, 'EXTRA_LOCAL_KEY').sampleValue, null);
  });

  it('marks the secret keys and the ones the manager fills per deployment', async () => {
    seedHostFiles();
    const id = await buildV3();

    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;
    const base = envFileAt(settings, '.env');
    const engine = envFileAt(settings, 'engines/srs/.env');
    const flags = (file: StackSettingsEnvFile, key: string): [boolean, boolean] => [
      entryFor(file, key).secret,
      entryFor(file, key).generated,
    ];

    assert.deepEqual(flags(base, 'API_AUTH_TOKEN'), [true, true]);
    assert.deepEqual(flags(base, 'STREAM_KEY'), [true, true]);
    assert.deepEqual(flags(base, 'PUBLISH_KEY_SECRET'), [true, false]);
    assert.deepEqual(flags(base, 'API_PORT'), [false, false]);
    assert.deepEqual(flags(engine, 'SRS_WEBHOOK_TOKEN'), [true, true]);
    assert.deepEqual(flags(engine, 'SRT_PASSPHRASE'), [true, true]);
    assert.deepEqual(flags(engine, 'SRS_ADAPTER_PORT'), [false, false]);
  });

  it('reads the engine env against the engine sample of the same build', async () => {
    seedHostFiles();
    const id = await buildV3();

    const engine = envFileAt(
      (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings,
      'engines/srs/.env',
    );

    assert.equal(entryFor(engine, 'SRT_PASSPHRASE').value, 'host-passphrase');
    assert.match(entryFor(engine, 'SRS_WEBHOOK_TOKEN').description, /^Shared secret SRS carries/);
    assert.equal(entryFor(engine, 'ABR_VHOST').value, 'abr');
  });

  it('answers the deploy config as text with the sample it can be reset to', async () => {
    seedHostFiles();
    const id = await buildV3();

    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;
    const config = settings.files.find((file) => file.path === 'deploy/config.json');

    assert.equal(config?.kind, 'json');
    assert.equal((config as StackSettingsJsonFile).text, HOST_DEPLOY_CONFIG);
    assert.equal((config as StackSettingsJsonFile).sampleText, CONFIG_SAMPLE);
  });

  it('refuses a version whose first build has not happened', async () => {
    const answer = await callJson('GET', `/versions/${await bundledId()}/settings`);

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'settings_not_ready');
    assert.match((answer.body as { message: string }).message, /first build/);
  });

  it('answers a version that is not there with a 404', async () => {
    const answer = await callJson('GET', '/versions/9999/settings');

    assert.equal(answer.status, 404);
    assert.equal((answer.body as { error: string }).error, 'stack_version_not_found');
  });

  it('refuses an id that is not one', async () => {
    assert.equal((await callJson('GET', '/versions/not-an-id/settings')).status, 400);
  });

  it('reads the files without changing a byte of them', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(configRoot, '.env'));

    await callJson('GET', `/versions/${id}/settings`);

    assert.deepEqual(readFileSync(join(configRoot, '.env')), before);
    assert.equal(dirname(join(configRoot, '.env')), configRoot);
  });
});
