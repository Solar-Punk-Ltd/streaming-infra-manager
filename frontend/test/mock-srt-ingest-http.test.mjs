/**
 * The offline mock's SRT ingest route, over its own authenticated HTTP.
 *
 * The mock is how the card is reviewed without a host, so it has to answer in
 * the shape the manager does and stay in the state a reviewer picked, because
 * the page asks again every ten seconds.
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

async function runningDeployment(engine) {
  const name = `mock-ingest-${nextProfile++}`;
  await request('/profiles', 'POST', { name, kind: 'custom', components: [engine, 'stream-uploader'], stack_version_id: 2 });
  await until(`/profiles/${name}`, (profile) => profile.status === 'RUNNING');
  return name;
}

describe('the mock SRT ingest route', { concurrency: false, timeout: 60_000 }, () => {
  it('answers a running SRS deployment with a measured, healthy minute', async () => {
    const name = await runningDeployment('srs');

    const reading = await request(`/profiles/${name}/srt-ingest`);

    assert.equal(reading.state, 'measured');
    assert.equal(reading.verdict, 'healthy');
    assert.equal(reading.windowSeconds, 60);
    assert.equal(reading.reports, 6);
    assert.deepEqual(Object.keys(reading.counts).sort(), ['dropped', 'lost', 'received', 'retransmitted']);
  });

  it('keeps the state a reviewer picked for the asks that follow', async () => {
    const name = await runningDeployment('srs');

    assert.equal((await request(`/profiles/${name}/srt-ingest?state=bad`)).verdict, 'bad');
    assert.equal((await request(`/profiles/${name}/srt-ingest`)).verdict, 'bad');
    assert.equal((await request(`/profiles/${name}/srt-ingest?state=not-a-state`)).verdict, 'bad');
    assert.equal((await request(`/profiles/${name}/srt-ingest?state=degraded`)).verdict, 'degraded');
    assert.deepEqual(await request(`/profiles/${name}/srt-ingest?state=no_reports`), {
      state: 'no_reports',
      windowSeconds: 60,
    });
  });

  it('says SRS is not running once the deployment stops', async () => {
    const name = await runningDeployment('srs');
    await request(`/profiles/${name}/srt-ingest?state=bad`);

    await fetch(`${base}/profiles/${name}/stop`, {
      method: 'POST',
      headers: { cookie, [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.text());
    await until(`/profiles/${name}`, (profile) => profile.status === 'STOPPED');

    assert.deepEqual(await request(`/profiles/${name}/srt-ingest`), { state: 'not_running', windowSeconds: 60 });
  });

  it('says a deployment on another engine has no SRT statistics', async () => {
    const name = await runningDeployment('ome');

    assert.deepEqual(await request(`/profiles/${name}/srt-ingest`), { state: 'not_srs', windowSeconds: 60 });
  });
});
