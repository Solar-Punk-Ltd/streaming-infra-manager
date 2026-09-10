import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { acquireLocalDockerBeeStream, openUnixDockerConnection } from '../../src/domain/chequebook/acquireLocalDockerBeeStream.js';
import { ChequebookTransferPreparation } from '../../src/domain/chequebook/ChequebookTransferPreparation.js';
import { ChequebookChainRegistry } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { syntheticDockerBee, syntheticImageId, syntheticTarget } from '../support/syntheticDockerBee.js';

it('runs native Unix connection plus synthetic Docker/Bee preparation and one submission in its owned temporary socket', { timeout: 5000 }, async t => {
  const directory = await mkdtemp('/tmp/t09-unix-');
  t.diagnostic(`Owned temporary Unix fixture: ${directory}`);
  const socketPath = join(directory, 'docker.sock');
  const docker = syntheticDockerBee(t, undefined, false);
  const connections = new Set<net.Socket>(); let accepted = 0;
  const server = net.createServer(socket => {
    accepted++; connections.add(socket); socket.on('error', () => {});
    socket.pipe(docker.transport).pipe(socket);
    socket.on('close', () => connections.delete(socket));
    docker.transport.once('close', () => socket.destroy());
  });
  const cleanup = async () => {
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  };
  t.after(async () => { try { await cleanup(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } });
  server.listen(socketPath); await once(server, 'listening');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const reader = {
    async chainId() { return 100; }, async transactionCount() { return '8'; },
    async transaction() { return null; }, async receipt() { return null; }, async blockTransactions() { return null; },
    async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; },
  };
  const preparation = ChequebookTransferPreparation.fromOwnedTarget(async () => syntheticTarget,
    (target, budgets, signal) => acquireLocalDockerBeeStream(target, async alias => ({ kind: 'unix', alias, socketPath }), budgets,
      execution => execution.imageId === syntheticImageId, signal),
    new ChequebookChainRegistry('{"100":"https://rpc.example.invalid"}', () => reader));
  const repository = new InMemoryChequebookOperations();
  const intent = transferIntent(); const submission = new ChequebookSubmission(repository, input => preparation.prepare(input));
  assert.equal((await submission.submit(intent)).operation.state, 'submitted');
  assert.equal((await submission.submit(intent)).kind, 'replayed');
  assert.equal(accepted, 1); assert.equal(docker.dockerRequests.length, 6); assert.equal(docker.counts().posts, 1);
  await cleanup();
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.equal(server.listening, false); assert.equal(connections.size, 0);
  t.diagnostic(`Verified removed: ${directory}`);
});

it('preserves arbitrary bytes and half-close on a native owned Unix socket', { timeout: 5000 }, async t => {
  const directory = await mkdtemp('/tmp/t09-unix-'); const socketPath = join(directory, 'echo.sock');
  t.diagnostic(`Owned temporary Unix fixture: ${directory}`);
  let peer: net.Socket | undefined;
  const server = net.createServer(socket => { peer = socket; socket.pipe(socket); });
  t.after(async () => { peer?.destroy(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  server.listen(socketPath); await once(server, 'listening');
  const connection = openUnixDockerConnection(socketPath);
  t.after(() => connection.stream.destroy()); await connection.connected;
  const payload = Buffer.from(Array.from({ length: 256 * 4096 }, (_, i) => i % 256));
  const chunks: Buffer[] = []; connection.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = once(connection.stream, 'end'); connection.stream.end(payload); await ended;
  assert.deepEqual(Buffer.concat(chunks), payload);
  connection.stream.destroy(); peer?.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true }); await assert.rejects(stat(directory), { code: 'ENOENT' });
  t.diagnostic(`Verified removed: ${directory}`);
});
