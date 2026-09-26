/**
 * The offline mock's deployment settings routes, over its own authenticated
 * HTTP.
 *
 * The mock is how the settings card is reviewed without a host, so it has to
 * answer in the shapes the manager does and refuse what the manager refuses:
 * a save against an older revision, a key a control of the deployment
 * decides, a value outside the stack's bounds, and an Apply for a stopped
 * deployment. And a deploy that lands has to record what the containers got,
 * or the banner could never clear.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-infra-manager/common';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';

let child;
let base;
let cookie;
let nextProfile = 1;

async function candidatePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** Any answer, refusals included, as its status and body. */
async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (path === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  const type = response.headers.get('content-type') ?? '';
  const answer = response.status === 204 ? null : type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body: answer };
}

async function request(path, method = 'GET', body) {
  const { status, body: answer } = await call(path, method, body);
  assert.ok(status >= 200 && status < 300, `${method} ${path} returned ${status}: ${JSON.stringify(answer)}`);
  return answer;
}

async function until(path, predicate) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const value = await request(path);
    if (predicate(value)) return value;
    await delay(30);
  }
  throw new Error(`Mock transition did not finish: ${path}`);
}

before(async () => {
  const port = await candidatePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', 'dev/mock-manager.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Owned mock did not start')), 8_000);
    let output = '';
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-4_096);
      if (output.includes(`mock manager on ${base} `)) finish();
    };
    const onExit = () => finish(new Error('Owned mock exited before startup'));
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', finish);
      error ? reject(error) : resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  await request('/auth/login', 'POST', { username: DEV_USERNAME, password: DEV_PASSWORD });
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timeout); }
});

/**
 * A running SRS stream on main-v3, the version whose contract names its
 * generated secrets. Stamped, because the mock starts an uploader only for a
 * deployment that has a batch to pay with.
 */
async function runningDeployment() {
  const name = `mock-settings-${nextProfile++}`;
  await request('/profiles', 'POST', {
    name, kind: 'custom', components: ['srs', 'stream-uploader'], stack_version_id: 2, stamp_id: 'ab'.repeat(32),
  });
  return (await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING')).name;
}

const settingsOf = (name) => request(`/profiles/${name}/settings`);
const entryOf = (catalog, key) => catalog.entries.find((entry) => entry.key === key);

async function saveOn(name, entries) {
  const catalog = await settingsOf(name);
  return call(`/profiles/${name}/settings`, 'PUT', {
    expectedInstanceId: catalog.instanceId,
    expectedRevision: catalog.revision,
    entries,
  });
}

describe('the mock deployment settings routes', { concurrency: false, timeout: 60_000 }, () => {
  it("lists the root sample's keys, then the engine's, with where each value comes from", async () => {
    const name = await runningDeployment();

    const catalog = await settingsOf(name);
    const keys = catalog.entries.map(({ key }) => key);

    assert.equal(catalog.running, true);
    assert.equal(catalog.revision, 0);
    assert.ok(keys.indexOf('LOG_LEVEL') < keys.indexOf('HLS_FRAGMENT'), keys.join(' '));
    assert.equal(keys.includes('HLS_SEGMENT_DURATION'), false, 'an SRS deployment lists no OvenMediaEngine key');
    assert.deepEqual(entryOf(catalog, 'LOG_LEVEL'), {
      key: 'LOG_LEVEL',
      section: 'Logging',
      description: 'How much the uploader logs. An unrecognized value is reported once and then ignored.',
      declared: true,
      secret: false,
      sampleValue: 'info',
      versionSet: true,
      versionValue: 'info',
      stored: false,
      storedValue: null,
      value: 'info',
      source: 'version',
      owner: null,
      field: { kind: 'choice', choices: ['debug', 'log', 'info', 'warn', 'error', 'silent'] },
      services: ['stream-uploader'],
      running: 'same',
      engineSetting: null,
    });
    assert.equal(entryOf(catalog, 'API_AUTH_TOKEN').source, 'generated');
    assert.equal(entryOf(catalog, 'HLS_FRAGMENT').owner, null);
    assert.equal(entryOf(catalog, 'STAMP').owner, 'stamp');
    assert.equal(entryOf(catalog, 'CLIENT_PORT').owner, 'port-slot');
    assert.deepEqual(catalog.drift, { keys: [], services: [], fullRedeploy: false });
  });

  it('stores a save, moves the revision, and puts the key behind the running containers', async () => {
    const name = await runningDeployment();

    const saved = await saveOn(name, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    const catalog = await settingsOf(name);

    assert.deepEqual(saved, { status: 200, body: { revision: 1 } });
    assert.equal(catalog.revision, 1);
    assert.equal(entryOf(catalog, 'LOG_LEVEL').storedValue, 'debug');
    assert.equal(entryOf(catalog, 'LOG_LEVEL').source, 'deployment');
    assert.equal(entryOf(catalog, 'LOG_LEVEL').running, 'differs');
    assert.deepEqual(catalog.drift, { keys: ['LOG_LEVEL'], services: ['stream-uploader'], fullRedeploy: false });
  });

  it('never answers a secret, only that one is stored', async () => {
    const name = await runningDeployment();
    const secret = 'offline-mock-token-not-a-real-one-0123456789abcdef';

    await saveOn(name, [{ key: 'ADMIN_API_TOKEN', value: secret }]);
    const answer = await call(`/profiles/${name}/settings`);

    assert.equal(JSON.stringify(answer.body).includes(secret), false);
    const token = entryOf(answer.body, 'ADMIN_API_TOKEN');
    assert.deepEqual({ stored: token.stored, storedValue: token.storedValue, value: token.value }, { stored: true, storedValue: null, value: null });
  });

  it("takes a reset back to the version's value", async () => {
    const name = await runningDeployment();
    await saveOn(name, [{ key: 'MAX_QUEUE_SIZE', value: '250' }]);

    await saveOn(name, [{ key: 'MAX_QUEUE_SIZE', value: null }]);
    const entry = entryOf(await settingsOf(name), 'MAX_QUEUE_SIZE');

    assert.deepEqual({ stored: entry.stored, value: entry.value, source: entry.source }, { stored: false, value: '100', source: 'version' });
  });

  it('refuses a save made against an older revision', async () => {
    const name = await runningDeployment();
    const catalog = await settingsOf(name);
    await saveOn(name, [{ key: 'LOG_LEVEL', value: 'warn' }]);

    const late = await call(`/profiles/${name}/settings`, 'PUT', {
      expectedInstanceId: catalog.instanceId,
      expectedRevision: catalog.revision,
      entries: [{ key: 'LOG_LEVEL', value: 'error' }],
    });

    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'deployment_settings_changed');
  });

  it('refuses a key a control decides, and a value outside its bounds, in the manager\'s words', async () => {
    const name = await runningDeployment();

    const owned = await saveOn(name, [{ key: 'STAMP', value: 'cd'.repeat(32) }]);
    const outOfBounds = await saveOn(name, [{ key: 'MAX_QUEUE_SIZE', value: '0' }]);

    assert.deepEqual(owned, {
      status: 400,
      body: { error: 'validation_error', errors: ["STAMP is set by the deployment's postage stamp, not here."], name },
    });
    assert.equal(outOfBounds.status, 400);
    assert.deepEqual(outOfBounds.body.errors, ['MAX_QUEUE_SIZE must be at least 1. Got 0.']);
    assert.equal((await settingsOf(name)).revision, 0, 'a refused save stores nothing');
  });

  it('refuses a body that is not a save before it reads any key', async () => {
    const name = await runningDeployment();

    const answer = await call(`/profiles/${name}/settings`, 'PUT', { expectedInstanceId: 'nope', expectedRevision: 0, entries: [] });

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'validation_error');
  });

  it('applies by redeploying, records what the containers got, and then has nothing behind', async () => {
    const name = await runningDeployment();
    await saveOn(name, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    const { instanceId } = await settingsOf(name);

    const applied = await call(`/profiles/${name}/settings/apply`, 'POST', { expectedInstanceId: instanceId });
    await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
    const after = await settingsOf(name);

    assert.deepEqual(applied, { status: 202, body: { recreated: ['stream-uploader'] } });
    assert.deepEqual(after.drift, { keys: [], services: [], fullRedeploy: false });
    assert.equal(entryOf(after, 'LOG_LEVEL').running, 'same');
  });

  it('answers an Apply with nothing behind as nothing recreated', async () => {
    const name = await runningDeployment();
    const { instanceId } = await settingsOf(name);

    assert.deepEqual(await call(`/profiles/${name}/settings/apply`, 'POST', { expectedInstanceId: instanceId }), {
      status: 200,
      body: { recreated: [] },
    });
  });

  it('says a key only the deploy scripts read is a full redeploy', async () => {
    const name = await runningDeployment();
    await saveOn(name, [{ key: 'BEE_UPLOADER_FULL_NODE', value: 'true' }]);
    const { drift, instanceId } = await settingsOf(name);

    assert.equal(drift.fullRedeploy, true);
    assert.deepEqual(await call(`/profiles/${name}/settings/apply`, 'POST', { expectedInstanceId: instanceId }), {
      status: 202,
      body: { recreated: 'all' },
    });
    await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
  });

  it('opens the seeded stages in the states the card is reviewed in', async () => {
    const main = await settingsOf('main-stage');
    const parked = await settingsOf('old-demo');
    const unrecorded = await settingsOf('field-unit');

    assert.deepEqual(main.drift, { keys: ['LOG_LEVEL'], services: ['stream-uploader'], fullRedeploy: false });
    assert.equal(entryOf(main, 'OLD_UPLOAD_RETRIES').declared, false);
    assert.equal(entryOf(main, 'ADMIN_API_TOKEN').stored, true);
    assert.equal(parked.running, false);
    assert.deepEqual(parked.drift.keys, ['CHEQUEBOOK_MIN_BZZ']);
    assert.ok(unrecorded.entries.every((entry) => entry.running === 'unknown'));
  });

  it('refuses an Apply for a stopped deployment, whose Start uses the saved settings', async () => {
    const { instanceId } = await settingsOf('old-demo');

    const answer = await call('/profiles/old-demo/settings/apply', 'POST', { expectedInstanceId: instanceId });

    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'profile_stopped');
  });
});

describe("the mock's engine settings in a deployment's settings", { concurrency: false, timeout: 60_000 }, () => {
  it('lists each engine setting the deployment reads as its own, with the default it falls back to on this host', async () => {
    const catalog = await settingsOf(await runningDeployment());
    const fragment = entryOf(catalog, 'HLS_FRAGMENT');
    const latency = entryOf(catalog, 'SRT_LATENCY');

    assert.deepEqual({ engine: catalog.engine, abr: catalog.abr }, { engine: 'srs', abr: false });
    assert.deepEqual(
      { owner: fragment.owner, versionValue: fragment.versionValue, source: fragment.source, facts: fragment.engineSetting, services: fragment.services },
      { owner: null, versionValue: '2', source: 'version', facts: { defaultSource: 'host', notInConfig: false }, services: ['srs', 'stream-uploader'] },
    );
    assert.deepEqual(
      { owner: latency.owner, versionValue: latency.versionValue, source: latency.source, defaultSource: latency.engineSetting?.defaultSource },
      { owner: null, versionValue: '2000', source: 'manager-default', defaultSource: 'manager' },
    );
    assert.equal(entryOf(catalog, 'HLS_SEGMENT_MAX')?.owner, null, 'a setting no sample declares is listed too');
  });

  it('saves an engine setting into the engine settings, which Apply then recreates the engine and the uploader for', async () => {
    const name = await runningDeployment();

    const saved = await saveOn(name, [{ key: 'HLS_FRAGMENT', value: '1' }]);
    const catalog = await settingsOf(name);
    const profile = await request(`/profiles/${name}`);
    const engine = await request(`/profiles/${name}/engine`);

    assert.deepEqual(saved, { status: 200, body: { revision: 1 } });
    assert.deepEqual(profile.engine_settings, { HLS_FRAGMENT: '1' });
    assert.equal(engine.settings.HLS_FRAGMENT, '1');
    assert.deepEqual(
      { source: entryOf(catalog, 'HLS_FRAGMENT').source, storedValue: entryOf(catalog, 'HLS_FRAGMENT').storedValue },
      { source: 'deployment', storedValue: '1' },
    );
    assert.deepEqual(catalog.drift, { keys: ['HLS_FRAGMENT'], services: ['srs', 'stream-uploader'], fullRedeploy: false });
    assert.deepEqual(await call(`/profiles/${name}/settings/apply`, 'POST', { expectedInstanceId: catalog.instanceId }), {
      status: 202,
      body: { recreated: ['srs', 'stream-uploader'] },
    });
    await until(`/profiles/${name}`, (current) => current.status === 'RUNNING');
    assert.deepEqual((await settingsOf(name)).drift, { keys: [], services: [], fullRedeploy: false });
  });

  it("refuses a pair the engine would refuse, in the engine's own words, and stores nothing", async () => {
    const name = await runningDeployment();

    const refused = await saveOn(name, [{ key: 'HLS_FRAGMENT', value: '3' }]);

    assert.equal(refused.status, 400);
    assert.match(refused.body.errors.join(' '), /^The force-close ceiling of 2\.5 seconds is below the segment length of 3 seconds/);
    assert.deepEqual((await request(`/profiles/${name}`)).engine_settings, {});
    assert.equal((await settingsOf(name)).revision, 0);
  });

  it('refuses a value outside its field, naming the key', async () => {
    const name = await runningDeployment();

    const outside = await saveOn(name, [{ key: 'SRT_LATENCY', value: '5' }]);

    assert.deepEqual(outside.body.errors, ['SRT_LATENCY: SRT latency must be at least 20. Got 5.']);
  });

  it('moves the revision on a scripted engine save, so a page that read before it is refused', async () => {
    const name = await runningDeployment();
    const before = await settingsOf(name);

    await request(`/profiles/${name}/engine-settings`, 'PUT', { HLS_WINDOW: '20', expectedInstanceId: before.instanceId });
    await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
    const late = await call(`/profiles/${name}/settings`, 'PUT', {
      expectedInstanceId: before.instanceId,
      expectedRevision: before.revision,
      entries: [{ key: 'HLS_WINDOW', value: '30' }],
    });

    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'deployment_settings_changed');
    assert.deepEqual((await request(`/profiles/${name}`)).engine_settings, { HLS_WINDOW: '20' });
  });
});

describe('the mock settings list and create for a deployment not made yet', { concurrency: false, timeout: 60_000 }, () => {
  const newList = (query) => request(`/versions/2/settings-catalog${query}`);

  it('lists what a deployment starts with on a version, storing and running nothing', async () => {
    const catalog = await newList('?kind=streamer&host=localhost');
    const keys = catalog.entries.map(({ key }) => key);

    assert.equal(catalog.versionId, 2);
    assert.ok(keys.indexOf('LOG_LEVEL') < keys.indexOf('HLS_FRAGMENT'), keys.join(' '));
    assert.ok(catalog.entries.every((entry) => !entry.stored && entry.running === 'not-running'));
    assert.deepEqual(
      [entryOf(catalog, 'LOG_LEVEL').value, entryOf(catalog, 'LOG_LEVEL').source],
      ['info', 'version'],
    );
    assert.equal(entryOf(catalog, 'API_AUTH_TOKEN').source, 'generated');
    assert.deepEqual([entryOf(catalog, 'STAMP').owner, entryOf(catalog, 'STAMP').value], ['stamp', null]);
    assert.deepEqual([entryOf(catalog, 'HLS_FRAGMENT').owner, entryOf(catalog, 'HLS_FRAGMENT').value], ['engine-settings', null]);
  });

  it('takes the engine sample of the engine the services select', async () => {
    const keys = (await newList('?kind=custom&components=ome,stream-uploader')).entries.map(({ key }) => key);

    assert.ok(keys.includes('HLS_SEGMENT_DURATION'), keys.join(' '));
    assert.equal(keys.includes('HLS_FRAGMENT'), false);
  });

  it('answers a version that does not exist with a 404, and a list no create could describe with a 400', async () => {
    assert.equal((await call('/versions/999/settings-catalog?kind=streamer')).status, 404);
    assert.equal((await call('/versions/2/settings-catalog?kind=custom&components=srs,ome')).status, 400);
  });

  it('creates a deployment with the settings it was given, which its page then lists as its own', async () => {
    const name = `mock-created-${nextProfile++}`;
    const secret = 'offline-mock-created-token-0123456789abcdef';

    const created = await call('/profiles', 'POST', {
      name, kind: 'custom', components: ['srs', 'stream-uploader'], stack_version_id: 2, stamp_id: 'ab'.repeat(32),
      stack_settings: [{ key: 'LOG_LEVEL', value: 'debug' }, { key: 'ADMIN_API_TOKEN', value: secret }],
    });
    await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
    const answer = await call(`/profiles/${name}/settings`);

    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(JSON.stringify(created.body).includes(secret), false);
    assert.deepEqual(
      [entryOf(answer.body, 'LOG_LEVEL').storedValue, entryOf(answer.body, 'LOG_LEVEL').source, entryOf(answer.body, 'LOG_LEVEL').running],
      ['debug', 'deployment', 'same'],
    );
    assert.equal(entryOf(answer.body, 'ADMIN_API_TOKEN').stored, true);
    assert.deepEqual(answer.body.drift, { keys: [], services: [], fullRedeploy: false });
    assert.equal(JSON.stringify(answer.body).includes(secret), false);
  });

  it("refuses a create with a key a control decides, in the manager's words, and creates nothing", async () => {
    const name = `mock-created-${nextProfile++}`;

    const refused = await call('/profiles', 'POST', {
      name, kind: 'custom', components: ['srs', 'stream-uploader'], stack_version_id: 2,
      stack_settings: [{ key: 'STAMP', value: 'cd'.repeat(32) }],
    });

    assert.deepEqual(refused, {
      status: 400,
      body: { error: 'validation_error', errors: ["STAMP is set by the deployment's postage stamp, not here."], name },
    });
    assert.equal((await call(`/profiles/${name}`)).status, 404);
  });

  it('gives every member of a group the same settings, and a member appended later those of its siblings', async () => {
    const groupName = `mock-fleet-${nextProfile++}`;

    const created = await request('/groups', 'POST', {
      group_name: groupName, size: 2, kind: 'custom', components: ['srs', 'stream-uploader'], stack_version_id: 2,
      stack_settings: [{ key: 'LOG_LEVEL', value: 'warn' }],
    });
    const appended = await request(`/groups/${created.group.id}/members`, 'POST', { count: 1 });

    const members = [...created.profiles, ...appended.profiles].map((profile) => profile.name);
    assert.equal(members.length, 3);
    for (const member of members) {
      assert.equal(entryOf(await settingsOf(member), 'LOG_LEVEL').storedValue, 'warn', member);
    }
  });
});
