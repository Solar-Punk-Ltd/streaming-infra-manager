import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '@streaming-infra-manager/common';
import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';

const bootstrap = `
import { state, makeProfile, node } from './dev/mock-seed.mjs';
await import('./dev/mock-manager.mjs');
for (const name of ['missing', 'unreadable', 'funded']) {
  state.profiles.push(makeProfile({ name, kind: 'custom', components: ['srs', 'stream-uploader', 'bee-uploader'] }));
}
node('unreadable').chequebook.available = 'synthetic-unreadable';
node('funded').chequebook.total = node('funded').chequebook.available = '10000000000000000';
state.profiles.push(makeProfile({ name: 'external', kind: 'custom', components: ['srs', 'stream-uploader'], bee_url: 'http://synthetic.invalid:1633' }));
state.profiles.push(makeProfile({ name: 'pool', kind: 'abr-uploader', bee_publishers: 'synthetic-pool' }));
process.send({ ready: true });
`;

let child;
let base;
let cookie;

async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}

before(async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', '--input-type=module', '-e', bootstrap], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Owned funding mock did not start')), 8000);
    const onMessage = message => { if (message?.ready) finish(); };
    const onExit = () => finish(new Error('Owned funding mock exited before startup'));
    const finish = error => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', finish);
      error ? reject(error) : resolve();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  const login = await request('/auth/login', 'POST', { username: DEV_USERNAME, password: DEV_PASSWORD });
  assert.equal(login.status, 200);
  cookie = login.cookie.split(';')[0];
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timeout); }
});

describe('authenticated offline uploader funding admission', { concurrency: false, timeout: 15000 }, () => {
  for (const name of ['missing', 'unreadable']) {
    it(`refuses ${name} local-node evidence without starting the uploader`, async () => {
      const before = await request(`/profiles/${name}`);
      assert.equal(before.status, 200);
      const result = await request(`/profiles/${name}/deploy-uploader`, 'POST');
      assert.equal(result.status, 502);
      assert.equal(result.body.error, 'bee_node_unreachable');
      assert.equal(result.body.name, name);
      assert.match(result.body.message, /uploader was not started/);
      assert.match(result.body.message, /Try again once the node answers/);
      assert.deepEqual((await request(`/profiles/${name}`)).body, before.body);
    });
  }

  for (const name of ['funded', 'external', 'pool']) {
    it(`preserves the ${name} uploader path`, async () => {
      const result = await request(`/profiles/${name}/deploy-uploader`, 'POST');
      assert.equal(result.status, 202);
      assert.equal((await request(`/profiles/${name}`)).body.status, 'DEPLOYING');
    });
  }
});
