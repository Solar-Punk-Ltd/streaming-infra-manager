/**
 * What the dev mock answers to a top-up and a dilute of a batch a node holds.
 *
 * A real mock manager over real HTTP, no browser. Runs with the other suites
 * here under `pnpm test:browser`. Nothing here reaches a Bee node or moves
 * money: the mock's nodes are in its own memory.
 *
 * The mock is what the Storage card's two dialogs are developed and reviewed
 * against, so it validates with the manager's own schemas, refuses in the
 * manager's own words, and changes the batch the way a mined transaction does,
 * a moment after it answers.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  minimumStampAmountPlur,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '@streaming-infra-manager/common';
import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';

const bootstrap = `
await import('./dev/mock-manager.mjs');
process.send({ ready: true });
`;

const DAY = 86_400;
const NODE = 'main-stage';
/** Longer than the mock takes to land a change, and short enough to fail fast. */
const SETTLE_BUDGET_MS = 8_000;

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
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie'),
  };
}

async function batches() {
  return (await request(`/profiles/${NODE}/stamp/stamps`)).body.stamps;
}

async function price() {
  return (await request(`/profiles/${NODE}/stamp/chainstate`)).body.currentPrice;
}

/** The batch once `landed` says the change has reached the node's list. */
async function settled(batchID, landed) {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    const batch = (await batches()).find((entry) => entry.batchID === batchID);
    if (batch && landed(batch)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the change to ${batchID} never reached the node's list`);
}

before(async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=development', '--input-type=module', '-e', bootstrap],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('the stamp mock did not start')), 20_000);
    const onMessage = (message) => {
      if (message?.ready) finish();
    };
    const onExit = () => finish(new Error('the stamp mock exited before startup'));
    const finish = (error) => {
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
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
});

describe('the offline mock changing a batch its node holds', { concurrency: false, timeout: 30_000 }, () => {
  it('answers a top-up with the batch and a transaction, and adds a day for a day’s amount once it lands', async () => {
    const [batch] = await batches();
    const oneDay = minimumStampAmountPlur(await price());

    const res = await request(`/profiles/${NODE}/stamp/topup`, 'POST', { batch_id: batch.batchID, amount: oneDay });

    assert.equal(res.status, 202);
    assert.equal(res.body.batchID, batch.batchID);
    assert.match(res.body.txHash, /^0x[0-9a-f]{64}$/);
    const after = await settled(batch.batchID, (entry) => entry.batchTTL !== batch.batchTTL);
    assert.equal(after.batchTTL, batch.batchTTL + DAY);
    assert.equal(after.depth, batch.depth);
  });

  it('answers a dilute the same way, and raises the depth and halves the life once it lands', async () => {
    const [batch] = await batches();

    const res = await request(`/profiles/${NODE}/stamp/dilute`, 'POST', { batch_id: `0x${batch.batchID}`, depth: batch.depth + 1 });

    assert.equal(res.status, 202);
    assert.equal(res.body.batchID, batch.batchID);
    const after = await settled(batch.batchID, (entry) => entry.depth !== batch.depth);
    assert.equal(after.depth, batch.depth + 1);
    assert.equal(after.batchTTL, Math.floor(batch.batchTTL / 2));
    assert.equal(after.utilization, batch.utilization, 'the fullest bucket keeps its count');
  });

  it('refuses a batch the node does not hold, in the manager’s words', async () => {
    const res = await request(`/profiles/${NODE}/stamp/topup`, 'POST', { batch_id: 'f'.repeat(64), amount: '1' });

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'stamp_not_found');
    assert.match(res.body.message, /does not hold batch f{64}/);
  });

  it('refuses a depth that is not deeper than the batch’s own, in the manager’s words', async () => {
    const [batch] = await batches();

    const res = await request(`/profiles/${NODE}/stamp/dilute`, 'POST', { batch_id: batch.batchID, depth: batch.depth });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'validation_error');
    assert.match(res.body.errors[0], new RegExp(`already at depth ${batch.depth}`));
  });

  it('names the pool’s full rung in its words, until the rung is diluted', async () => {
    const { groups } = (await request('/groups')).body;
    const pool = groups.find((group) => group.kind === 'abr-node-pool');
    const fullRung = async () =>
      (await request(`/groups/${pool.id}/bee-publishers`)).body.missing.find((entry) => entry.rung === '720p') ?? null;
    const before = await fullRung();
    assert.match(before?.reason ?? '', /full, so its node refuses uploads/);

    const [batch] = (await request('/profiles/abr-pool-1-720p/stamp/stamps')).body.stamps;
    const res = await request('/profiles/abr-pool-1-720p/stamp/dilute', 'POST', { batch_id: batch.batchID, depth: batch.depth + 1 });
    assert.equal(res.status, 202);

    const deadline = Date.now() + SETTLE_BUDGET_MS;
    while ((await fullRung()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await fullRung(), null, 'a diluted rung is half full and publishable again');
  });

  it('refuses a body the manager’s schemas refuse', async () => {
    const [batch] = await batches();
    for (const [route, body] of [
      ['topup', { batch_id: batch.batchID, amount: '0' }],
      ['topup', { batch_id: 'a'.repeat(63), amount: '1' }],
      ['dilute', { batch_id: batch.batchID, depth: 41 }],
    ]) {
      const res = await request(`/profiles/${NODE}/stamp/${route}`, 'POST', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, 'validation_error');
    }
  });
});
