import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { PinnedBeeSession } from '../../src/domain/chequebook/PinnedBeeSession.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { InMemoryChequebookOperations, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

async function beeServer(port = 0, mode: 'normal' | 'close' | 'drop_post' | 'slow_body' | 'oversized' | 'redirect' = 'normal') {
  let posts = 0;
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      if (mode === 'drop_post') { req.socket.destroy(); return; }
    }
    if (mode === 'redirect') { res.writeHead(302, { location: '/chequebook/deposit?amount=1' }); res.end(); return; }
    if (mode === 'close') res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'slow_body') { res.write('{'); return; }
    if (mode === 'oversized') { res.end(JSON.stringify({ value: 'x'.repeat(1024) })); return; }
    res.end(JSON.stringify(req.method === 'POST' ? { transactionHash } : req.url === '/addresses' ? { ethereum: transferContext.nodeAddress } : {
      walletAddress: transferContext.nodeAddress, chequebookContractAddress: transferContext.chequebookAddress,
      chainID: 100, bzzBalance: '10000000000000000', nativeTokenBalance: '10000000000000000',
    }));
  });
  server.on('connection', socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, counts: () => ({ posts, connections, sockets: sockets.size }),
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe('one-connection Bee transfer session', () => {
  it('uses one connection for identity, wallet and the single POST then refuses another POST', async t => {
    const bee = await beeServer();
    const session = new PinnedBeeSession(bee.url);
    t.after(async () => { session.dispose(); await bee.close(); });
    assert.equal((await session.getAddresses()).ethereum, transferContext.nodeAddress);
    await session.getWallet();
    assert.equal((await session.depositChequebook(1n)).transactionHash, transactionHash);
    await assert.rejects(session.withdrawChequebook(1n), /Bee connection/i);
    assert.deepEqual(bee.counts(), { posts: 1, connections: 1, sockets: 1 });
  });

  it('never reconnects to replacement B after A closes following the final identity read', async t => {
    const a = await beeServer();
    const session = new PinnedBeeSession(a.url);
    await session.getWallet();
    await session.getAddresses();
    await a.close();
    const b = await beeServer(a.port);
    t.after(async () => { session.dispose(); await b.close(); });
    await assert.rejects(session.depositChequebook(1n), /Bee connection/i);
    assert.equal(b.counts().posts, 0);
    assert.equal(b.counts().connections, 0);
  });

  it('refuses a server-requested Connection: close before dispatch', async t => {
    const bee = await beeServer(0, 'close');
    const session = new PinnedBeeSession(bee.url);
    t.after(async () => { session.dispose(); await bee.close(); });
    const repository = new InMemoryChequebookOperations();
    const submission = new ChequebookSubmission(repository, async () => ({ context: transferContext,
      dispose: () => session.dispose(), preflight: async () => { await session.getAddresses(); }, send: async () => session.depositChequebook(1n) }));
    const result = await submission.submit(transferIntent());
    assert.equal(result.operation.state, 'rejected');
    assert.equal(result.operation.dispatchStartedAt, null);
    assert.equal(bee.counts().posts, 0);
  });

  it('keeps a close during the committed dispatch claim unknown and sends nothing to replacement B', async t => {
    const a = await beeServer();
    const session = new PinnedBeeSession(a.url);
    const repository = new InMemoryChequebookOperations();
    const claim = repository.claimDispatch.bind(repository);
    let b: Awaited<ReturnType<typeof beeServer>> | undefined;
    t.after(async () => { session.dispose(); if (b) await b.close(); else await a.close(); });
    repository.claimDispatch = async id => {
      const result = await claim(id);
      await a.close();
      b = await beeServer(a.port);
      return result;
    };
    const submission = new ChequebookSubmission(repository, async () => {
      await session.getWallet();
      return { context: transferContext, dispose: () => session.dispose(),
        preflight: async () => { await session.getAddresses(); }, send: async () => session.depositChequebook(1n) };
    });
    const intent = transferIntent();
    assert.equal((await submission.submit(intent)).operation.state, 'unknown');
    assert.equal((await submission.submit(intent)).kind, 'replayed');
    assert.equal(b?.counts().posts, 0);
    assert.equal(b?.counts().connections, 0);
  });

  it('keeps an accepted POST with a lost response unknown and never retries it', async t => {
    const bee = await beeServer(0, 'drop_post');
    const repository = new InMemoryChequebookOperations();
    let prepares = 0;
    let session: PinnedBeeSession | undefined;
    t.after(async () => { session?.dispose(); await bee.close(); });
    const submission = new ChequebookSubmission(repository, async () => {
      prepares++;
      session = new PinnedBeeSession(bee.url);
      const bound = session;
      await bound.getAddresses();
      return { context: transferContext, dispose: () => bound.dispose(), preflight: async () => { await bound.getWallet(); }, send: async () => bound.depositChequebook(1n) };
    });
    const intent = transferIntent();
    const first = await submission.submit(intent);
    assert.equal(first.operation.state, 'unknown');
    assert.equal((await submission.submit(intent)).operation.id, first.operation.id);
    assert.equal(prepares, 1);
    assert.equal(bee.counts().posts, 1);
    assert.equal((await repository.admit({ ...first.operation, id: crypto.randomUUID(), requestId: crypto.randomUUID() })).kind, 'busy');
  });

  it('bounds the whole response and byte count and never follows a redirect', async () => {
    for (const mode of ['slow_body', 'oversized', 'redirect'] as const) {
      const bee = await beeServer(0, mode);
      const session = new PinnedBeeSession(bee.url, { readTimeoutMs: 30, maxResponseBytes: 128 });
      try {
        await assert.rejects(session.getWallet(), error => error instanceof Error && error.name === 'BeeConnectionError' && !error.message.includes(bee.url));
        assert.equal(bee.counts().posts, 0);
      } finally { session.dispose(); await bee.close(); }
    }
  });

  it('rejects untrusted URL shapes and makes disposal permanent', async t => {
    for (const url of ['https://example.test', 'http://user:secret@example.test', 'http://example.test/path', 'http://example.test/?token=secret']) {
      assert.throws(() => new PinnedBeeSession(url), /Bee connection/i);
    }
    const bee = await beeServer();
    t.after(() => bee.close());
    const session = new PinnedBeeSession(bee.url);
    session.dispose(); session.dispose();
    await assert.rejects(session.getAddresses(), /Bee connection/i);
    assert.equal(bee.counts().connections, 0);
  });
});
