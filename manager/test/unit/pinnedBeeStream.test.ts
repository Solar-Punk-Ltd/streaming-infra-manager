import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { Duplex, PassThrough, Transform } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import { PinnedBeeSession } from '../../src/domain/chequebook/PinnedBeeSession.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { createDockerExecDuplex } from '../../src/domain/chequebook/createDockerExecDuplex.js';
import { InMemoryChequebookOperations, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
function syntheticBee(t: TestContext, handler?: Handler, dockerFrames = false) {
  const inbound = dockerFrames ? new Transform({ transform(chunk: Buffer, _encoding, callback) {
    const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(chunk.length, 4);
    callback(null, Buffer.concat([header, chunk]));
  } }) : new PassThrough();
  const outbound = new PassThrough();
  const transport = Duplex.from({ readable: inbound, writable: outbound });
  const owned = dockerFrames ? createDockerExecDuplex(transport, {
    maxFrameBytes: 64 * 1024, maxOutputBytes: 1024 * 1024, maxInputBytes: 64 * 1024, totalTimeoutMs: 2000,
  }) : transport;
  const peer = Duplex.from({ readable: outbound, writable: inbound });
  const requests: { method: string; url: string; host: string }[] = [];
  let acquisitions = 0;
  let closes = 0;
  const forbidden = () => { acquisitions++; throw new Error('Network acquisition is forbidden in this synthetic fixture.'); };
  t.mock.method(net, 'createConnection', forbidden);
  t.mock.method(net, 'connect', forbidden);
  syncBuiltinESMExports();
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method!, url: request.url!, host: request.headers.host! });
    if (handler) handler(request, response);
    else response.end(JSON.stringify(request.method === 'POST' ? { transactionHash } : request.url === '/addresses'
      ? { ethereum: transferContext.nodeAddress } : { walletAddress: transferContext.nodeAddress }));
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  owned.on('close', () => { closes++; });
  peer.on('error', () => {});
  server.emit('connection', peer);
  t.after(() => { owned.destroy(); peer.destroy(); server.close(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { owned, peer, requests, counts: () => ({ acquisitions, closes, posts: requests.filter(request => request.method === 'POST').length }) };
}

describe('Bee HTTP over one already acquired owned byte stream', { timeout: 5000 }, () => {
  it('uses native HTTP for successive GETs and exactly one POST without acquiring a socket', async t => {
    const bee = syntheticBee(t);
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    assert.equal((await session.getAddresses()).ethereum, transferContext.nodeAddress);
    await session.getWallet();
    assert.equal((await session.depositChequebook(1n)).transactionHash, transactionHash);
    await assert.rejects(session.withdrawChequebook(1n), /Bee connection/i);
    await assert.rejects(session.getAddresses(), /Bee connection/i);
    assert.deepEqual(bee.requests.map(request => [request.method, request.url]), [['GET', '/addresses'], ['GET', '/wallet'], ['POST', '/chequebook/deposit?amount=1']]);
    assert.equal(new Set(bee.requests.map(request => request.host)).size, 1);
    assert.match(bee.requests[0]!.host, /\.invalid$/);
    assert.equal(bee.counts().acquisitions, 0);
    assert.equal(bee.counts().posts, 1);
  });

  it('owns and disposes an unused stream before any GET and never reopens it', async t => {
    const bee = syntheticBee(t);
    const session = PinnedBeeSession.fromStream(bee.owned);
    session.dispose(); session.dispose();
    await assert.rejects(session.getAddresses(), /Bee connection/i);
    await pause(0);
    assert.equal(bee.owned.destroyed, true);
    assert.equal(bee.counts().closes, 1);
    assert.equal(bee.counts().acquisitions, 0);
  });

  it('composes with the strict Docker stdout decoder while request bytes remain unframed', async t => {
    const bee = syntheticBee(t, undefined, true);
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    await session.getAddresses();
    await session.getWallet();
    assert.equal((await session.withdrawChequebook(2n)).transactionHash, transactionHash);
    assert.deepEqual(bee.requests.map(request => request.url), ['/addresses', '/wallet', '/chequebook/withdraw?amount=2']);
    assert.equal(bee.counts().acquisitions, 0);
    session.dispose();
    await pause(0);
    assert.equal(bee.owned.destroyed, true);
    assert.equal(bee.counts().closes, 1);
  });

  for (const mode of ['destroyed', 'encoded', 'read-ended', 'write-ended'] as const) {
    it(`disposes and refuses a ${mode} acquired stream`, async t => {
      const bee = syntheticBee(t);
      bee.owned.on('error', () => {});
      if (mode === 'destroyed') bee.owned.destroy();
      if (mode === 'encoded') bee.owned.setEncoding('utf8');
      if (mode === 'read-ended') { bee.owned.push(null); bee.owned.resume(); await pause(0); }
      if (mode === 'write-ended') bee.owned.end();
      assert.throws(() => PinnedBeeSession.fromStream(bee.owned), /Bee connection/i);
      assert.equal(bee.owned.destroyed, true);
      assert.equal(bee.counts().acquisitions, 0);
    });
  }

  it('disposes the acquired stream for a malformed runtime options object', async t => {
    const bee = syntheticBee(t);
    // @ts-expect-error Exercise the runtime boundary used by non-TypeScript callers.
    assert.throws(() => PinnedBeeSession.fromStream(bee.owned, null), /Bee connection/i);
    assert.equal(bee.owned.destroyed, true);
    bee.owned.emit('error', new Error('sensitive late error'));
  });

  it('refuses reuse after the acquired stream closes following a successful GET', async t => {
    const bee = syntheticBee(t);
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    await session.getAddresses();
    bee.peer.destroy(); await pause(0);
    await assert.rejects(session.getWallet(), /Bee connection/i);
    await assert.rejects(session.depositChequebook(1n), /Bee connection/i);
    assert.equal(bee.counts().acquisitions, 0);
    assert.equal(bee.counts().posts, 0);
  });

  it('refuses Connection: close from a GET without attempting replacement', async t => {
    const bee = syntheticBee(t, (_request, response) => { response.setHeader('Connection', 'close'); response.end('{}'); });
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    await assert.rejects(session.getAddresses(), /Bee connection/i);
    await assert.rejects(session.depositChequebook(1n), /Bee connection/i);
    assert.equal(bee.counts().posts, 0);
    assert.equal(bee.counts().acquisitions, 0);
  });

  it('rejects concurrent reads and POSTs while letting the first read complete', async t => {
    let held: http.ServerResponse | undefined;
    const bee = syntheticBee(t, (request, response) => {
      if (request.method === 'GET') held = response;
      else response.end(JSON.stringify({ transactionHash }));
    });
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    const first = session.getAddresses();
    while (!held) await pause(0);
    await assert.rejects(session.getWallet(), /Bee connection/i);
    await assert.rejects(session.depositChequebook(1n), /Bee connection/i);
    held.end(JSON.stringify({ ethereum: transferContext.nodeAddress }));
    await first;
    assert.equal((await session.depositChequebook(1n)).transactionHash, transactionHash);
    assert.equal(bee.counts().posts, 1);
    assert.equal(bee.counts().acquisitions, 0);
  });

  for (const mode of ['slow', 'declared-size', 'streamed-size', 'redirect', 'invalid-json', 'truncated-body'] as const) {
    it(`contains a ${mode} response and permanently refuses further use`, async t => {
      const bee = syntheticBee(t, (_request, response) => {
        if (mode === 'slow') { response.write('{'); return; }
        if (mode === 'declared-size') { response.setHeader('Content-Length', '1024'); response.flushHeaders(); return; }
        if (mode === 'streamed-size') { response.write('x'.repeat(256)); response.end(); return; }
        if (mode === 'redirect') { response.writeHead(302, { Location: 'http://sensitive.invalid' }); response.end(); return; }
        if (mode === 'truncated-body') { response.setHeader('Content-Length', '12'); response.write('{'); setImmediate(() => response.destroy()); return; }
        response.end('sensitive invalid response');
      });
      const session = PinnedBeeSession.fromStream(bee.owned, { readTimeoutMs: 20, maxResponseBytes: 128 });
      t.after(() => session.dispose());
      await assert.rejects(session.getAddresses(), error => error instanceof Error && error.name === 'BeeConnectionError' && !error.message.includes('sensitive') && error.cause === undefined);
      await assert.rejects(session.getWallet(), /Bee connection/i);
      assert.equal(bee.owned.destroyed, true);
      assert.equal(bee.counts().acquisitions, 0);
    });
  }

  it('keeps an accepted POST with a lost response unknown and replays the saved request without sending', async t => {
    const bee = syntheticBee(t, (request, response) => {
      if (request.method === 'POST') { request.socket.destroy(); return; }
      response.end('{}');
    });
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    const repository = new InMemoryChequebookOperations();
    let preparations = 0;
    const submission = new ChequebookSubmission(repository, async () => {
      preparations++; await session.getAddresses();
      return { context: transferContext, dispose: () => session.dispose(), preflight: async () => {}, send: () => session.depositChequebook(1n) };
    });
    const intent = transferIntent();
    const first = await submission.submit(intent);
    assert.equal(first.operation.state, 'unknown');
    assert.equal((await submission.submit(intent)).kind, 'replayed');
    assert.equal(preparations, 1);
    assert.equal(bee.counts().posts, 1);
    assert.equal(bee.counts().acquisitions, 0);
  });

  it('retains a complete hash response even when the server then closes, without permitting another POST', async t => {
    const bee = syntheticBee(t, (request, response) => {
      if (request.method === 'POST') response.setHeader('Connection', 'close');
      response.end(JSON.stringify(request.method === 'POST' ? { transactionHash } : {}));
    });
    const session = PinnedBeeSession.fromStream(bee.owned);
    t.after(() => session.dispose());
    await session.getAddresses();
    assert.equal((await session.depositChequebook(1n)).transactionHash, transactionHash);
    await assert.rejects(session.depositChequebook(1n), /Bee connection/i);
    assert.equal(bee.counts().posts, 1);
  });

  it('expires while a committed journal claim waits and sends zero POST bytes', async t => {
    const bee = syntheticBee(t);
    const session = PinnedBeeSession.fromStream(bee.owned, { preflightTimeoutMs: 30 });
    t.after(() => session.dispose());
    const repository = new InMemoryChequebookOperations();
    const claim = repository.claimDispatch.bind(repository);
    repository.claimDispatch = async id => { const value = await claim(id); await pause(40); return value; };
    const submission = new ChequebookSubmission(repository, async () => {
      await session.getAddresses();
      return { context: transferContext, dispose: () => session.dispose(), preflight: async () => {}, send: () => session.depositChequebook(1n) };
    });
    const result = await submission.submit(transferIntent());
    assert.equal(result.operation.state, 'unknown');
    assert.ok(result.operation.dispatchStartedAt);
    assert.equal(bee.counts().posts, 0);
    assert.equal(bee.counts().acquisitions, 0);
  });

  it('contains late owned-stream errors before first use and after disposal', async t => {
    const bee = syntheticBee(t);
    const session = PinnedBeeSession.fromStream(bee.owned);
    bee.owned.emit('error', new Error('sensitive early error'));
    await assert.rejects(session.getAddresses(), /Bee connection/i);
    session.dispose();
    bee.owned.emit('error', new Error('sensitive late error'));
    assert.equal(bee.counts().acquisitions, 0);
  });

  for (const options of [{ readTimeoutMs: 0 }, { postTimeoutMs: Infinity }, { preflightTimeoutMs: -1 }, { maxResponseBytes: 0 }]) {
    it(`disposes an owned stream when options are invalid: ${Object.keys(options)[0]}`, async t => {
      const bee = syntheticBee(t);
      assert.throws(() => PinnedBeeSession.fromStream(bee.owned, options), /Bee connection/i);
      assert.equal(bee.owned.destroyed, true);
      bee.owned.emit('error', new Error('sensitive after invalid construction'));
      await pause(0);
      assert.equal(bee.counts().closes, 1);
      assert.equal(bee.counts().acquisitions, 0);
    });
  }
});
