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
for (const name of ['missing', 'unreadable', 'funded', 'low']) {
  state.profiles.push(makeProfile({ name, kind: 'custom', components: ['srs', 'stream-uploader', 'bee-uploader'] }));
}
node('unreadable').chequebook.available = 'synthetic-unreadable';
node('funded').chequebook.total = node('funded').chequebook.available = '10000000000000000';
node('low').chequebook.total = node('low').chequebook.available = '1000000000000000';
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
  return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie') };
}

/** For the action routes, which answer with a script's event stream and not JSON. */
async function requestStream(path, method = 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      ...(cookie ? { cookie } : {}),
    },
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, frames: await response.text() };
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
  assert.equal(login.status, 204);
  cookie = login.cookie.split(';')[0];
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timeout); }
});

/**
 * The mock's uploader start, which since the owner's ruling of 2026-09-17 refuses
 * nothing about funding.
 *
 * This suite used to pin three refusals: a node the mock does not hold, a balance
 * it cannot parse, and a balance under the floor. The manager refuses on none of
 * them now, so the property worth holding is the opposite one, and it is worth
 * holding because a mock that grows a refusal production does not have reports
 * every such start as a failure on a laptop while the host is fine. What decides
 * whether a start worked is the script's own last frame, which is what the page
 * reads.
 */
describe('authenticated offline uploader funding admission', { concurrency: false, timeout: 15000 }, () => {
  for (const name of ['missing', 'unreadable', 'low', 'funded', 'external', 'pool']) {
    it(`starts the ${name} uploader and reports how the script ended`, async () => {
      const result = await requestStream(`/profiles/${name}/deploy-uploader`);
      assert.equal(result.status, 200);
      assert.match(result.frames, /event: done\ndata: \{"code":0\}/);
      assert.equal((await request(`/profiles/${name}`)).body.status, 'DEPLOYING');
    });
  }
});
