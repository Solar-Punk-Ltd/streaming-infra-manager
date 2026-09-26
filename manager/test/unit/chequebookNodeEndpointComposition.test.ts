/**
 * The production composition reads the chain through the node's own endpoint
 * when CHEQUEBOOK_RPC_ENDPOINTS names none: for the transfer it prepares, for
 * the receipt polling that settles it, and for a manager restarted while that
 * polling was still owed, which has to read the container again to learn it.
 */
import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import pg from 'pg';
import type { ChequebookOperation } from '@streaming-infra-manager/common';
import { createChequebookOperationsService, type ChequebookServiceDependencies } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { syntheticDockerHost, syntheticNodeChainEndpoint, syntheticTarget } from '../support/syntheticDockerBee.js';

const transports = JSON.stringify({ [syntheticTarget.alias]: {
  locator: { kind: 'unix', alias: syntheticTarget.alias, socketPath: '/synthetic/docker.sock' }, qualificationIds: ['synthetic-only'] } });
const quietLog = { info() {}, warn() {} };
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

/** Answers the start block before the transfer and one canonical finalized success receipt after it. */
function chain(): { reader: ChequebookChainReader; settle(operation: ChequebookOperation): void } {
  let settled: ChequebookOperation | null = null;
  const hashAt = (number: bigint) => number === 500n ? transferContext.startBlockHash : `0x${number.toString(16).padStart(64, '0')}`;
  const transaction = () => ({ hash: settled!.transactionHash!, chainId: 100, from: settled!.nodeAddress, to: settled!.tokenAddress,
    data: `0xa9059cbb${settled!.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(settled!.amountPlur).toString(16).padStart(64, '0')}`,
    nonce: '9', value: '0', blockNumber: '501', blockHash: hashAt(501n) });
  return {
    settle(operation) { settled = operation; },
    reader: { async chainId() { return 100; }, async transactionCount() { return '8'; }, async blockTransactions() { return null; },
      async transaction(hash) { return settled && hash === settled.transactionHash ? transaction() : null; },
      async receipt(hash) { return settled && hash === settled.transactionHash ? { transactionHash: hash, from: settled.nodeAddress, to: settled.tokenAddress,
        blockNumber: '501', blockHash: hashAt(501n), status: 'success' as const } : null; },
      async blockHeader(block) { const number = block === 'finalized' || block === 'latest' ? (settled ? 501n : 500n) : block;
        return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) }; } },
  };
}

function composition(t: TestContext, repository = new InMemoryChequebookOperations()) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
  const host = syntheticDockerHost(t);
  const scripted = chain();
  const endpoints: string[] = [];
  const dependencies: ChequebookServiceDependencies = { repository, qualificationCatalog: [qualifiedBridge()], captureTarget: async () => structuredClone(syntheticTarget),
    createChainReader: endpoint => { endpoints.push(endpoint); return scripted.reader; }, connectUnix: host.connect,
    preparation: { cleanupGraceMs: 20, timeoutMs: 3000 }, receiptPolling: { intervalMs: 5, log: quietLog } };
  const start = () => {
    const service = createChequebookOperationsService(pool, { rpcEndpoints: undefined, dockerTransports: transports }, dependencies);
    t.after(() => service.shutdown());
    return service;
  };
  return { host, scripted, endpoints, repository, start };
}

async function settledWithin(repository: InMemoryChequebookOperations, id: string): Promise<ChequebookOperation | null> {
  for (let round = 0; round < 400; round++) {
    const row = await repository.findById(id);
    if (row?.state === 'settled') return row;
    await pause();
  }
  return repository.findById(id);
}

it('prepares a transfer through the endpoint its node was started with when none is configured', async t => {
  const c = composition(t);
  const result = await c.start().submit(transferIntent());
  assert.equal(result.operation.state, 'submitted');
  assert.deepEqual([...new Set(c.endpoints)], [syntheticNodeChainEndpoint]);
  assert.equal(c.host.posts(), 1);
});

it('polls that transfer to settlement through the same endpoint without reading the container again', async t => {
  const c = composition(t);
  const service = c.start();
  const operation = (await service.submit(transferIntent())).operation;
  const connections = c.host.fixtures.length;
  c.scripted.settle(operation);
  service.start();
  assert.equal((await settledWithin(c.repository, operation.id))?.state, 'settled');
  assert.deepEqual([...new Set(c.endpoints)], [syntheticNodeChainEndpoint]);
  assert.equal(c.host.fixtures.length, connections, 'the endpoint was remembered from the preparation');
});

it('lets a restarted manager read the node\'s container again to poll a transfer it did not prepare', async t => {
  const c = composition(t);
  const operation = (await c.start().submit(transferIntent())).operation;
  const connections = c.host.fixtures.length;
  c.scripted.settle(operation);
  const restarted = c.start();
  restarted.start();
  assert.equal((await settledWithin(c.repository, operation.id))?.state, 'settled');
  assert.deepEqual([...new Set(c.endpoints)], [syntheticNodeChainEndpoint]);
  assert.ok(c.host.fixtures.length > connections, 'the restarted manager read the container to learn the endpoint');
  assert.equal(c.host.posts(), 1, 'reading the endpoint sent nothing');
});
