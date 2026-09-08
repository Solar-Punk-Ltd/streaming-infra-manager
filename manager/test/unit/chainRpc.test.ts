import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { ChainRpc } from '../../src/domain/chequebook/ChainRpc.js';

const hash = `0x${'ab'.repeat(32)}`;
const parentHash = `0x${'cd'.repeat(32)}`;
const address = `0x${'12'.repeat(20)}`;
type RequestBody = { id: number; method: string; params: unknown[]; jsonrpc: string };
const cleanups: Array<() => Promise<void>> = [];

async function rpcServer(handle: (body: RequestBody, response: ServerResponse) => void) {
  const calls: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
    calls.push(body);
    handle(body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const bound = server.address();
  assert.ok(bound && typeof bound !== 'string');
  return { url: `http://127.0.0.1:${bound.port}/synthetic-private-path`, calls };
}

function reply(response: ServerResponse, request: RequestBody, result: unknown) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('bounded read-only chain RPC', () => {
  it('requests finalized explicitly without falling back to latest', async () => {
    const server = await rpcServer((body, response) => reply(response, body, { hash, parentHash, number: '0x1f4' }));
    assert.deepEqual(await new ChainRpc(server.url).blockHeader('finalized'), { hash, parentHash, number: '500' });
    assert.deepEqual(server.calls.map(call => call.params), [['finalized', false]]);
  });

  it('uses exact JSON-RPC methods, correlates ids and keeps the endpoint private', async () => {
    const server = await rpcServer((body, response) => reply(response, body, '0x64'));
    const rpc = new ChainRpc(server.url);
    assert.equal(await rpc.chainId(), 100);
    assert.equal(await rpc.chainId(), 100);
    assert.deepEqual(server.calls.map(call => [call.method, call.params, call.jsonrpc]), [['eth_chainId', [], '2.0'], ['eth_chainId', [], '2.0']]);
    assert.notEqual(server.calls[0]!.id, server.calls[1]!.id);
    assert.ok(!JSON.stringify(rpc).includes('synthetic-private-path'));
  });

  it('reads the nonce at an explicit block tag without rounding', async () => {
    const server = await rpcServer((body, response) => reply(response, body, '0x20000000000001'));
    assert.equal(await new ChainRpc(server.url).transactionCount(address, 500n), '9007199254740993');
    assert.deepEqual(server.calls[0]!.params, [address, '0x1f4']);
    assert.equal(server.calls[0]!.method, 'eth_getTransactionCount');
  });

  it('reads transaction and receipt evidence by the exact requested hash', async () => {
    const transaction = { hash, chainId: '0x64', type: '0x2', from: address, to: address, input: '0x', nonce: '0x1', value: '0x0', blockNumber: '0x1f4', blockHash: hash };
    const receipt = { transactionHash: hash, from: address, to: address, blockNumber: '0x1f4', blockHash: hash, status: '0x1' };
    const server = await rpcServer((body, response) => reply(response, body, body.method === 'eth_getTransactionByHash' ? transaction : receipt));
    const rpc = new ChainRpc(server.url);
    assert.equal((await rpc.transaction(hash))?.nonce, '1');
    assert.equal((await rpc.receipt(hash))?.status, 'success');
    assert.ok(server.calls.every(call => call.params.length === 1 && call.params[0] === hash));
  });

  it('preserves absent evidence as null', async () => {
    const server = await rpcServer((body, response) => reply(response, body, null));
    const rpc = new ChainRpc(server.url);
    assert.equal(await rpc.transaction(hash), null);
    assert.equal(await rpc.receipt(hash), null);
    assert.equal(await rpc.blockHeader(500n), null);
    assert.equal(await rpc.blockTransactions(500n, address), null);
  });

  it('checks numbered blocks and every included transaction against their block identity', async () => {
    const transaction = { hash: parentHash, chainId: '0x64', type: '0x2', from: address, to: address, input: '0x', nonce: '0x1', value: '0x0', blockNumber: '0x1f4', blockHash: hash, transactionIndex: '0x0' };
    const server = await rpcServer((body, response) => reply(response, body, body.method === 'eth_getBlockTransactionCountByHash' ? '0x1' : { hash, parentHash, number: '0x1f4', transactions: body.params[1] ? [transaction] : [parentHash] }));
    const rpc = new ChainRpc(server.url);
    assert.deepEqual(await rpc.blockHeader('latest'), { hash, parentHash, number: '500' });
    assert.equal((await rpc.blockTransactions(500n, address))?.transactions[0]?.hash, parentHash);
    assert.deepEqual(server.calls.map(call => call.params), [['latest', false], ['0x1f4', true], [hash]]);
    await assert.rejects(rpc.blockHeader(501n), /could not be verified/i);
    transaction.blockHash = parentHash;
    await assert.rejects(rpc.blockTransactions(500n, address), /could not be verified/i);
  });

  it('scans past unrelated unprotected transactions but refuses unverifiable node-owned evidence', async () => {
    const unrelated = { hash: parentHash, type: '0x0', v: '0x1b', from: `0x${'34'.repeat(20)}`, to: address, input: '0x', nonce: '0x1', value: '0x0', blockNumber: '0x1f4', blockHash: hash, transactionIndex: '0x0' };
    const intended = { ...unrelated, hash: `0x${'56'.repeat(32)}`, from: address, type: '0x2', chainId: '0x64', transactionIndex: '0x1' };
    const server = await rpcServer((body, response) => reply(response, body, body.method === 'eth_getBlockTransactionCountByHash' ? '0x2' : { hash, parentHash, number: '0x1f4', transactions: [unrelated, intended] }));
    const rpc = new ChainRpc(server.url);
    assert.deepEqual((await rpc.blockTransactions(500n, address))?.transactions.map(transaction => transaction.hash), [intended.hash]);
    unrelated.from = address;
    await assert.rejects(rpc.blockTransactions(500n, address), /could not be verified/i);
    unrelated.from = '';
    await assert.rejects(rpc.blockTransactions(500n, address), /could not be verified/i);
  });

  it('refuses skipped positions, duplicate hashes and a tail missing from the reported block', async () => {
    const first = { hash: parentHash, chainId: '0x64', type: '0x2', from: address, to: address, input: '0x', nonce: '0x1', value: '0x0', blockNumber: '0x1f4', blockHash: hash, transactionIndex: '0x0' };
    const second = { ...first, hash: `0x${'56'.repeat(32)}`, nonce: '0x2', transactionIndex: '0x1' };
    for (const [transactions, count] of [
      [[first, { ...second, transactionIndex: '0x2' }], '0x2'],
      [[{ ...first, transactionIndex: undefined }, second], '0x2'],
      [[first, { ...second, hash: first.hash }], '0x2'],
      [[first], '0x2'],
      [[first, second], null],
    ] as const) {
      const server = await rpcServer((body, response) => reply(response, body, body.method === 'eth_getBlockTransactionCountByHash' ? count : { hash, parentHash, number: '0x1f4', transactions }));
      await assert.rejects(new ChainRpc(server.url).blockTransactions(500n, address), /could not be verified/i);
    }
  });

  it('refuses mismatched response ids, RPC errors, malformed envelopes and invalid JSON', async () => {
    for (const body of [
      { jsonrpc: '2.0', id: 999, result: '0x64' },
      { jsonrpc: '2.0', id: 1, error: { message: 'synthetic-private-path' } },
      { jsonrpc: '2.0', id: 1, result: '0x64', error: null },
      { jsonrpc: '1.0', id: 1, result: '0x64' },
      { jsonrpc: '2.0', id: 1 },
      'not JSON',
    ]) {
      const server = await rpcServer((_, response) => response.end(typeof body === 'string' ? body : JSON.stringify(body)));
      await assert.rejects(new ChainRpc(server.url).chainId(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'ChainReadError');
        assert.ok(!JSON.stringify(error).includes('synthetic-private-path'));
        assert.ok(!error.message.includes(server.url));
        return true;
      });
      assert.equal(server.calls.length, 1);
    }
  });

  it('refuses a valid-looking transaction or receipt for another hash', async () => {
    const server = await rpcServer((body, response) => reply(response, body, body.method === 'eth_getTransactionByHash'
      ? { hash: parentHash, chainId: '0x64', type: '0x2', from: address, to: address, input: '0x', nonce: '0x1', value: '0x0', blockNumber: null, blockHash: null }
      : { transactionHash: parentHash, blockHash: hash, blockNumber: '0x1f4', from: address, to: address, status: '0x1' }));
    const rpc = new ChainRpc(server.url);
    await assert.rejects(rpc.transaction(hash), /could not be verified/i);
    await assert.rejects(rpc.receipt(hash), /could not be verified/i);
  });

  it('never follows redirects or retries HTTP errors', async () => {
    const server = await rpcServer((_, response) => { response.writeHead(302, { location: '/another-path' }); response.end(); });
    await assert.rejects(new ChainRpc(server.url).chainId(), /could not be read/i);
    assert.equal(server.calls.length, 1);
    const failing = await rpcServer((_, response) => { response.writeHead(503); response.end('synthetic-private-path'); });
    await assert.rejects(new ChainRpc(failing.url).chainId(), /could not be read/i);
    assert.equal(failing.calls.length, 1);
  });

  it('bounds the whole request including a body that stalls after headers', async () => {
    for (const sendHeaders of [false, true]) {
      const server = await rpcServer((_, response) => { if (sendHeaders) { response.writeHead(200); response.write('{'); } });
      await assert.rejects(new ChainRpc(server.url, { timeoutMs: 30 }).chainId(), /could not be read/i);
      assert.ok(server.calls.length <= 1);
    }
  });

  it('bounds streamed bytes even without a Content-Length header', async () => {
    const server = await rpcServer((_, response) => { response.writeHead(200); response.write(' '.repeat(100)); response.end(' '.repeat(100)); });
    await assert.rejects(new ChainRpc(server.url, { maxResponseBytes: 128 }).chainId(), /could not be read/i);
  });

  it('honors a caller deadline and rejects invalid arguments before sending', async () => {
    const server = await rpcServer(() => {});
    const rpc = new ChainRpc(server.url);
    await assert.rejects(rpc.chainId(AbortSignal.abort()), /could not be read/i);
    await assert.rejects(rpc.transaction('bad-hash'), /could not be verified/i);
    await assert.rejects(rpc.transactionCount('bad-address', 500n), /could not be verified/i);
    await assert.rejects(rpc.blockHeader(-1n), /could not be verified/i);
    assert.equal(server.calls.length, 0);
    assert.throws(() => new ChainRpc(server.url, { timeoutMs: Infinity }), /could not be read/i);
    assert.throws(() => new ChainRpc(server.url, { maxResponseBytes: 0 }), /could not be read/i);
  });
});
