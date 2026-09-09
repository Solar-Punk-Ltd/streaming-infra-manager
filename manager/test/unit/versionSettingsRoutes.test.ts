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
      'engines/ome/.env',
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

  it('seeds an env for every engine the version ships a sample for', async () => {
    const id = await buildV3();

    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;

    assert.deepEqual(settings.files.map((file) => file.path), [
      '.env',
      'deploy/config.json',
      'engines/ome/.env',
      'engines/srs/.env',
    ]);
    assert.equal(
      readFileSync(join(configRoot, 'engines', 'ome', '.env'), 'utf8'),
      readFileSync(join(V3_FIXTURE, 'engines', 'ome', '.env.sample'), 'utf8'),
    );
  });

  it('describes an engine key from that engine own sample', async () => {
    const id = await buildV3();

    const ome = envFileAt(
      (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings,
      'engines/ome/.env',
    );

    assert.match(entryFor(ome, 'OME_ADMISSION_SECRET').description, /^Shared secret for the admission webhook/);
    assert.equal(entryFor(ome, 'OME_ADMISSION_SECRET').secret, true);
    assert.equal(entryFor(ome, 'OME_SRT_PORT').value, '10081');
  });

  it('leaves an engine env the host already keeps as the host wrote it', async () => {
    seedHostFiles();
    const id = await buildV3();

    const engine = readFileSync(join(configRoot, 'engines', 'srs', '.env'), 'utf8');

    assert.equal(engine.startsWith(HOST_ENGINE_ENV), true, engine.slice(0, 40));
    assert.equal(
      entryFor(
        envFileAt((await callJson('GET', `/versions/${id}/settings`)).body as StackSettings, 'engines/srs/.env'),
        'SRT_PASSPHRASE',
      ).value,
      'host-passphrase',
    );
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

  it('says which revision the current build carries, so a saved change that no build has is visible', async () => {
    seedHostFiles();
    const id = await buildV3();

    const carried = ((await callJson('GET', `/versions/${id}/settings`)).body as StackSettings);
    await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });
    const lagging = ((await callJson('GET', `/versions/${id}/settings`)).body as StackSettings);

    assert.deepEqual(
      { generation: carried.generation, buildGeneration: carried.buildGeneration },
      { generation: 2, buildGeneration: 2 },
    );
    assert.deepEqual(
      { generation: lagging.generation, buildGeneration: lagging.buildGeneration },
      { generation: 3, buildGeneration: 2 },
    );
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

describe('PUT /versions/:id/settings', () => {
  it('replaces one value and leaves every other byte of the file where it was', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(configRoot, '.env'), 'utf8');

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'API_AUTH_TOKEN', value: 'a'.repeat(64) }] }],
    });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { generation: 3 });
    assert.equal(
      readFileSync(join(configRoot, '.env'), 'utf8'),
      before.replace('API_AUTH_TOKEN=host-token', `API_AUTH_TOKEN=${'a'.repeat(64)}`),
    );
  });

  it('appends a key the file does not assign yet', async () => {
    seedHostFiles();
    const id = await buildV3();

    await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'BRAND_NEW_KEY', value: 'yes' }] }],
    });

    assert.match(readFileSync(join(configRoot, '.env'), 'utf8'), /\nBRAND_NEW_KEY=yes\n$/);
  });

  it('takes a key out of the file when it is asked to remove it', async () => {
    seedHostFiles();
    const id = await buildV3();

    await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'EXTRA_LOCAL_KEY', value: '', remove: true }] }],
    });

    const written = readFileSync(join(configRoot, '.env'), 'utf8');
    assert.equal(written.includes('EXTRA_LOCAL_KEY'), false);
    assert.equal(written.includes('# The token this host was given.'), true);
  });

  it('writes every file of one save under one new generation', async () => {
    seedHostFiles();
    const id = await buildV3();

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [
        { path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] },
        { path: 'engines/srs/.env', entries: [{ key: 'SRS_SRT_PORT', value: '10081' }] },
        { path: 'deploy/config.json', text: '{\n  "services": ["srs", "ome"]\n}\n' },
      ],
    });

    assert.deepEqual(answer.body, { generation: 3 });
    assert.match(readFileSync(join(configRoot, '.env'), 'utf8'), /^API_PORT=3100$/m);
    assert.match(readFileSync(join(configRoot, 'engines', 'srs', '.env'), 'utf8'), /^SRS_SRT_PORT=10081$/m);
    assert.equal(
      readFileSync(join(configRoot, 'deploy', 'config.json'), 'utf8'),
      '{\n  "services": ["srs", "ome"]\n}\n',
    );
  });

  it('leaves the files the save did not name alone', async () => {
    seedHostFiles();
    const id = await buildV3();
    const engine = readFileSync(join(configRoot, 'engines', 'srs', '.env'));
    const config = readFileSync(join(configRoot, 'deploy', 'config.json'));

    await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });

    assert.deepEqual(readFileSync(join(configRoot, 'engines', 'srs', '.env')), engine);
    assert.deepEqual(readFileSync(join(configRoot, 'deploy', 'config.json')), config);
  });

  it('refuses a save made against a revision the version has moved past', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(configRoot, '.env'));

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 1,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });

    assert.equal(answer.status, 409);
    assert.deepEqual(
      { error: (answer.body as { error: string }).error, generation: (answer.body as { generation: number }).generation },
      { error: 'settings_changed', generation: 2 },
    );
    assert.deepEqual(readFileSync(join(configRoot, '.env')), before);
  });

  it('refuses a key that is not an env name', async () => {
    seedHostFiles();
    const id = await buildV3();

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'not a key', value: 'x' }] }],
    });

    assert.equal(answer.status, 400);
    assert.equal((answer.body as { error: string }).error, 'validation_error');
  });

  it('refuses a value carrying a line break, which would become a second key', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(configRoot, '.env'));

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100\nSTAMP=stolen' }] }],
    });

    assert.equal(answer.status, 400);
    assert.deepEqual(readFileSync(join(configRoot, '.env')), before);
  });

  it('refuses a deploy config that does not parse', async () => {
    seedHostFiles();
    const id = await buildV3();
    const before = readFileSync(join(configRoot, 'deploy', 'config.json'));

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: 'deploy/config.json', text: '{ not json' }],
    });

    assert.equal(answer.status, 400);
    assert.deepEqual(readFileSync(join(configRoot, 'deploy', 'config.json')), before);
  });

  it('refuses a path outside the set', async () => {
    seedHostFiles();
    const id = await buildV3();

    for (const path of ['../outside/.env', 'deploy/scripts/deploy.sh', '.git/config']) {
      const answer = await callJson('PUT', `/versions/${id}/settings`, {
        expectedGeneration: 2,
        files: [{ path, entries: [{ key: 'API_PORT', value: '3100' }] }],
      });
      assert.equal(answer.status, 400, path);
    }
  });

  it('refuses a path of the set the version does not keep a file at', async () => {
    seedHostFiles();
    const id = await buildV3();

    const answer = await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: 'engines/nosuchengine/.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });

    assert.equal(answer.status, 400);
    assert.match(JSON.stringify(answer.body), /engines\/nosuchengine\/\.env/);
  });

  it('refuses text where the file takes keys, and keys where it takes text', async () => {
    seedHostFiles();
    const id = await buildV3();

    assert.equal(
      (await callJson('PUT', `/versions/${id}/settings`, {
        expectedGeneration: 2,
        files: [{ path: '.env', text: 'API_PORT=3100' }],
      })).status,
      400,
    );
    assert.equal(
      (await callJson('PUT', `/versions/${id}/settings`, {
        expectedGeneration: 2,
        files: [{ path: 'deploy/config.json', entries: [{ key: 'A', value: 'b' }] }],
      })).status,
      400,
    );
  });

  it('refuses a version whose first build has not happened', async () => {
    const answer = await callJson('PUT', `/versions/${await bundledId()}/settings`, {
      expectedGeneration: 1,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'settings_not_ready');
  });

  it('shows the saved value on the next read, at the new generation', async () => {
    seedHostFiles();
    const id = await buildV3();

    await callJson('PUT', `/versions/${id}/settings`, {
      expectedGeneration: 2,
      files: [{ path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] }],
    });
    const settings = (await callJson('GET', `/versions/${id}/settings`)).body as StackSettings;

    assert.equal(settings.generation, 3);
    assert.equal(entryFor(envFileAt(settings, '.env'), 'API_PORT').value, '3100');
  });
});
