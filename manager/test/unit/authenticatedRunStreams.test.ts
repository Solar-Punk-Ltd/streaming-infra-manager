import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';

import express from 'express';

import { createActionsRouter } from '../../src/api/routes/actions.js';
import { createVersionsRouter } from '../../src/api/routes/versions.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import type { DeployService } from '../../src/domain/DeployService.js';
import type { RunHandle } from '../../src/domain/ScriptRunner.js';
import type { StackVersionService } from '../../src/domain/versions/StackVersionService.js';

const TOKEN_HASH = 'a'.repeat(64);
const USER_ID = 7;

function signal<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runHandle() {
  const emitter = new EventEmitter();
  let kills = 0;
  const handle: RunHandle = { emitter, kill: () => { kills += 1; } };
  return { handle, kills: () => kills };
}

async function listen(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authSession = {
      tokenHash: TOKEN_HASH,
      user: { id: USER_ID, username: 'owner', isAdmin: true },
      expiresAt: new Date(Date.now() + 60_000),
    };
    next();
  });
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

describe('authenticated action and build streams', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

  it('ends a live deploy stream on revocation without killing the accepted deploy', async () => {
    const streams = new OpenStreams();
    const running = runHandle();
    const service = { run: async () => running.handle } as unknown as DeployService;
    const server = await listen(createActionsRouter(service, streams));
    servers.push(server);
    const response = await fetch(`${server.url}/profiles/stage/deploy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });

    running.handle.emitter.emit('stdout', 'before-revocation');
    try {
      assert.equal(streams.closeSession(TOKEN_HASH), 1);
      running.handle.emitter.emit('stdout', 'after-revocation');
      const body = await response.text();
      assert.match(body, /before-revocation/);
      assert.doesNotMatch(body, /after-revocation/);
      assert.equal(running.kills(), 0);
    } finally {
      running.handle.emitter.emit('done', { code: 0, signal: null });
      await response.text().catch(() => undefined);
    }
  });

  it('registers a pending build before awaiting its handle and never reopens it after revocation', async () => {
    const streams = new OpenStreams();
    const running = runHandle();
    const entered = signal();
    const release = signal<{ version: { name: string; gitRef: string }; handle: RunHandle }>();
    const service = {
      add: async () => {
        entered.resolve();
        return release.promise;
      },
    } as unknown as StackVersionService;
    const server = await listen(createVersionsRouter(service, streams));
    servers.push(server);
    const abort = new AbortController();
    const request = fetch(`${server.url}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'candidate', ref: 'main-v3' }),
      signal: abort.signal,
    }).catch(() => undefined);
    try {
      await within(entered.promise, 'build admission');
      assert.deepEqual(streams.openTokenHashes(), [TOKEN_HASH]);
      assert.equal(streams.closeSession(TOKEN_HASH), 1);
      release.resolve({ version: { name: 'candidate', gitRef: 'main-v3' }, handle: running.handle });
      await new Promise(resolve => setImmediate(resolve));
      running.handle.emitter.emit('stdout', 'after-revocation');
      assert.deepEqual(streams.openTokenHashes(), []);
      assert.equal(running.handle.emitter.listenerCount('stdout'), 0);
      assert.equal(running.kills(), 0);
    } finally {
      release.resolve({ version: { name: 'candidate', gitRef: 'main-v3' }, handle: running.handle });
      running.handle.emitter.emit('done', { code: 0, signal: null });
      abort.abort();
      await request;
    }
  });
});
