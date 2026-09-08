import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  });
  assert.ok(response.ok, `${method} ${path} returned ${response.status}`);
  if (path === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0];
  return response.status === 204 ? null : response.json();
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
    const onData = chunk => {
      output = (output + chunk.toString()).slice(-4_096);
      if (output.includes(`mock manager on ${base} `)) finish();
    };
    const onExit = () => finish(new Error('Owned mock exited before startup'));
    const finish = error => {
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

async function profileFor(engine, name = `mock-observation-${nextProfile++}`) {
  await request('/profiles', 'POST', {
    name, kind: 'custom', components: [engine, 'stream-uploader'], stack_version_id: 2,
    engine_settings: { HLS_FRAGMENT: '7', HLS_WINDOW: '45', HLS_SEGMENT_DURATION: '7', OME_HLS_POLL_INTERVAL_MS: '750' },
  });
  await until(`/profiles/${name}`, profile => profile.status === 'RUNNING');
  const path = `/profiles/${name}/engine-config`;
  const { template } = await request(path);
  return {
    name, path, template,
    put: config => request(path, 'PUT', { config }),
    overview: () => request(`/profiles/${name}/engine`),
    settled: () => until(`/profiles/${name}`, profile => profile.status === 'RUNNING'),
  };
}

const omeLiteral = template => template.replace('SEGMENT_DURATION_PLACEHOLDER', '4').replace('SEGMENT_COUNT_PLACEHOLDER', '5');
const srsScope = (name, fragment = '4') => `vhost ${name} { hls { hls_fragment ${fragment}; hls_window 30; } }`;

describe('stored config observations over authenticated mock HTTP', { concurrency: false, timeout: 60_000 }, () => {
  it('reads OME literal values from the same config returned by the editor', async () => {
    const profile = await profileFor('ome');
    const config = omeLiteral(profile.template);
    await profile.put(config);
    assert.equal((await request(profile.path)).config, config);
    const overview = await profile.overview();
    assert.equal(overview.effective.HLS_SEGMENT_DURATION, '4');
    assert.equal(overview.observations.HLS_SEGMENT_DURATION.source, 'config-file');
    assert.equal(overview.effective.OME_HLS_POLL_INTERVAL_MS, '750');
  });

  it('distinguishes an omitted OME leaf from a duplicate path', async () => {
    const profile = await profileFor('ome');
    const config = omeLiteral(profile.template);
    await profile.put(config.replace('<SegmentDuration>4</SegmentDuration>', ''));
    const missing = await profile.overview();
    assert.equal(missing.observations.HLS_SEGMENT_DURATION.source, 'omitted');
    assert.equal(missing.effective.HLS_SEGMENT_COUNT, '5');
    await profile.settled();
    await profile.put(config.replace('<SegmentDuration>4</SegmentDuration>', '<SegmentDuration>4</SegmentDuration><SegmentDuration>4</SegmentDuration>'));
    const duplicate = await profile.overview();
    assert.equal(duplicate.observations.HLS_SEGMENT_DURATION.reason, 'ambiguous-path');
    assert.equal(duplicate.effective.HLS_SEGMENT_DURATION, undefined);
    assert.equal(duplicate.effective.OME_HLS_POLL_INTERVAL_MS, '750');
  });

  it('reads SRS literals and leaves include-affected fields unverified', async () => {
    const profile = await profileFor('srs');
    await profile.put(srsScope('main'));
    assert.equal((await profile.overview()).effective.HLS_FRAGMENT, '4');
    await profile.settled();
    await profile.put(srsScope('main').replace('hls_window 30;', 'hls_window 30; include unavailable.conf;'));
    const overview = await profile.overview();
    assert.equal(overview.observations.HLS_FRAGMENT.reason, 'unsupported-syntax');
    assert.equal(overview.effective.HLS_FRAGMENT, undefined);
  });

  it('uses the shared first-on-line SRS substitution rule', async () => {
    const profile = await profileFor('srs');
    const one = srsScope('one', 'HLS_FRAGMENT_PLACEHOLDER');
    const two = srsScope('two', 'HLS_FRAGMENT_PLACEHOLDER');
    await profile.put(`${one} ${two}`);
    const sameLine = await profile.overview();
    assert.equal(sameLine.observations.HLS_FRAGMENT.reason, 'unsupported-syntax');
    assert.equal(sameLine.effective.HLS_WINDOW, '30');
    await profile.settled();
    await profile.put(`${one}\n${two}`);
    const separate = await profile.overview();
    assert.equal(separate.effective.HLS_FRAGMENT, '7');
    assert.equal(separate.observations.HLS_FRAGMENT.source, 'deployment');
  });

  it('reads edited, reverted and reset values from the current stored config', async () => {
    const profile = await profileFor('ome');
    const original = omeLiteral(profile.template);
    await profile.put(original);
    await profile.settled();
    await profile.put(original.replace('<SegmentDuration>4', '<SegmentDuration>5') + '\n<!-- fail -->');
    assert.equal((await profile.overview()).effective.HLS_SEGMENT_DURATION, '5');
    await profile.settled();
    assert.equal((await request(profile.path)).config, original);
    assert.equal((await profile.overview()).effective.HLS_SEGMENT_DURATION, '4');
    await request(profile.path, 'DELETE');
    assert.equal((await request(profile.path)).config, null);
    const reset = await profile.overview();
    assert.equal(reset.effective.HLS_SEGMENT_DURATION, '7');
    assert.equal(reset.observations.HLS_SEGMENT_DURATION.source, 'deployment');
  });

  it('forgets a removed deployment config before the name is reused', async () => {
    const profile = await profileFor('ome');
    await profile.put(omeLiteral(profile.template));
    await profile.settled();
    await request(`/profiles/${profile.name}`, 'DELETE');
    await until('/profiles', result => result.profiles.every(row => row.name !== profile.name));
    const replacement = await profileFor('ome', profile.name);
    assert.equal((await request(replacement.path)).config, null);
    assert.equal((await replacement.overview()).observations.HLS_SEGMENT_DURATION.source, 'deployment');
  });

  it('a delayed apply completion cannot restore the removed instance config over its replacement', async () => {
    const profile = await profileFor('ome');
    const original = omeLiteral(profile.template);
    await profile.put(original);
    await profile.settled();
    await profile.put(original.replace('<SegmentDuration>4', '<SegmentDuration>5') + '\n<!-- fail -->');
    const removed = await request(`/profiles/${profile.name}`, 'DELETE');
    await until('/profiles', result => result.profiles.every(row => row.name !== profile.name));
    const replacement = await profileFor('ome', profile.name);
    const current = await replacement.settled();
    assert.notEqual(current.instance_id, removed.instance_id);
    assert.equal(current.engine_config_state, null);
    assert.equal((await request(replacement.path)).config, null);
    assert.equal((await replacement.overview()).effective.HLS_SEGMENT_DURATION, '7');
  });

  it('a removed instance watch cannot overwrite replacement config or its previous-file recovery', async () => {
    const profile = await profileFor('ome');
    const original = omeLiteral(profile.template);
    await profile.put(original.replace('<SegmentDuration>4', '<SegmentDuration>5') + '\n<!-- crash -->');
    await until(`/profiles/${profile.name}`, row => row.engine_config_state === 'watching');
    await request(`/profiles/${profile.name}`, 'DELETE');
    await until('/profiles', result => result.profiles.every(row => row.name !== profile.name));
    const replacement = await profileFor('ome', profile.name);
    const replacementConfig = omeLiteral(replacement.template).replace('<SegmentDuration>4', '<SegmentDuration>6');
    await replacement.put(replacementConfig);
    await replacement.settled();
    assert.equal((await request(replacement.path)).config, replacementConfig);
    await replacement.put(replacementConfig.replace('<SegmentDuration>6', '<SegmentDuration>7') + '\n<!-- interrupt -->');
    await until(`/profiles/${profile.name}`, row => row.engine_config_state === 'interrupted');
    await request(`${replacement.path}/restore-previous`, 'POST');
    await replacement.settled();
    assert.equal((await request(replacement.path)).config, replacementConfig);
    assert.equal((await replacement.overview()).effective.HLS_SEGMENT_DURATION, '6');
  });
});
