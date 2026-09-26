/**
 * A Bee image nothing has qualified is checked before any money moves through it.
 *
 * The production composition, with no transport configured, meets an image
 * that is neither in the seed catalog nor stored as a pass. It reads the
 * container on a short-lived connection of its own, runs the check there,
 * stores what it found, and only then opens the bridge's connection, which
 * re-reads the tuple and must find the stored pass before its exec. A failed
 * check is stored with its reason and refuses with that check named, and
 * nothing reaches Bee.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import pg from 'pg';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { ChequebookPreparationError } from '../../src/domain/errors/ChequebookPreparationError.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { beeBridgeCheckEvidence, beeBridgeCheckVerdict } from '../../src/domain/chequebook/beeBridgeCheck.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import { syntheticBeeBridgeCheckAnswer } from '../support/beeBridgeCheckAnswer.js';
import { InMemoryBeeBridgeQualifications } from '../support/InMemoryBeeBridgeQualifications.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { fakeForwardHarness } from '../support/sshForwardLifecycle.js';
import { syntheticContainerId, syntheticContainerInspect, syntheticDockerHost, syntheticImageId, syntheticTarget,
  type SyntheticDockerAnswer } from '../support/syntheticDockerBee.js';

const chainReader = { async chainId() { return 100; }, async transactionCount() { return '8'; }, async transaction() { return null; },
  async receipt() { return null; }, async blockTransactions() { return null; },
  async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; } };
const onHost = (alias: string): FrozenChequebookTarget =>
  ({ ...structuredClone(syntheticTarget), alias, profile: { ...structuredClone(syntheticTarget.profile), host: alias === 'localhost' ? null : alias } });
const syntheticTuple = { imageId: syntheticImageId, engineVersion: '29.1.3', platform: { os: 'linux', architecture: 'amd64', variant: '' } };

function unqualified(t: TestContext, options: { checkAnswer?: string; alias?: string; answer?: SyntheticDockerAnswer; seeded?: boolean; ssh?: boolean;
  store?: (log: string[]) => InMemoryBeeBridgeQualifications } = {}) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
  const log: string[] = [];
  const host = syntheticDockerHost(t, undefined, options.answer, { checkAnswer: options.checkAnswer, log });
  const store = options.store?.(log) ?? new InMemoryBeeBridgeQualifications(log);
  const repository = new InMemoryChequebookOperations();
  const remote = fakeForwardHarness();
  remote.dependencies.clock = { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } };
  remote.dependencies.connect = () => host.connect();
  remote.dependencies.acquire = acquireDockerBeeStream;
  const service = createChequebookOperationsService(pool, { rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: undefined }, {
    repository, bridgeQualifications: store, qualificationCatalog: options.seeded ? [qualifiedBridge()] : undefined,
    captureTarget: async () => onHost(options.alias ?? 'localhost'), createChainReader: () => chainReader,
    connectUnix: host.connect, ssh: remote.dependencies, preparation: { cleanupGraceMs: 20, timeoutMs: 3000 },
  });
  t.after(() => service.shutdown());
  return { service, host, store, repository, log, remote };
}

describe('automatic qualification of a Bee image nothing has checked', { timeout: 20_000 }, () => {
  it('checks the image on a connection of its own, stores the pass, then transfers over the bridge\'s own connection', async t => {
    const h = unqualified(t);
    const result = await h.service.submit(transferIntent());
    assert.equal(result.operation.state, 'submitted');
    assert.equal(h.host.fixtures.length, 2, 'one connection for the check and one for the bridge');
    const [probe, bridge] = h.host.fixtures;
    assert.deepEqual(probe!.dockerRequests.filter(request => request.exec).map(request => request.exec), ['check']);
    assert.deepEqual(probe!.beeRequests, [], 'the check\'s connection never reaches Bee');
    assert.deepEqual(bridge!.dockerRequests.filter(request => request.exec).map(request => request.exec), ['bridge']);
    assert.equal(h.host.posts(), 1);
    assert.equal(h.store.rows.length, 1);
    assert.equal(h.store.rows[0]!.failedCheck, null);
    assert.deepEqual({ ...h.store.rows[0]!.tuple, bridgeRevision: undefined }, { ...syntheticTuple, bridgeRevision: undefined });
    assert.equal(h.store.rows[0]!.hostAlias, 'localhost');
  });

  it('stores the pass before any bridge exec, any Bee request and any send', async t => {
    const h = unqualified(t);
    await h.service.submit(transferIntent());
    const stored = h.log.indexOf('pass stored');
    assert.ok(stored > h.log.indexOf('docker start check'), 'the pass follows the check');
    assert.ok(stored < h.log.indexOf('docker exec bridge'), 'and precedes the bridge exec');
    assert.ok(stored < h.log.findIndex(line => line.startsWith('bee ')), 'and every Bee request');
  });

  it('reads the stored pass again before the bridge runs, and refuses when the check passed but no pass was stored', async t => {
    class LosesEveryWrite extends InMemoryBeeBridgeQualifications {
      override async record(): Promise<void> {}
    }
    const h = unqualified(t, { store: log => new LosesEveryWrite(log) });
    await assert.rejects(h.service.submit(transferIntent()), error => {
      assert.ok(error instanceof ChequebookPreparationError);
      assert.equal(error.refusal.cause, 'unavailable');
      return true;
    });
    assert.deepEqual(h.host.dockerRequests().filter(request => request.exec).map(request => request.exec), ['check'], 'the check ran and the bridge did not');
    assert.deepEqual(h.host.beeRequests(), [], 'no Bee request');
    assert.equal(h.host.posts(), 0, 'no send');
    assert.equal(h.repository.rows.size, 0, 'nothing admitted');
  });

  it('needs no check for a tuple the store already passed, and still reads it on its own connection first', async t => {
    const h = unqualified(t);
    const tuple = { ...syntheticTuple, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION };
    await h.store.record({ tuple, failedCheck: null, evidence: beeBridgeCheckEvidence(tuple, beeBridgeCheckVerdict(syntheticBeeBridgeCheckAnswer())), hostAlias: 'bee-eu-1' });
    assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
    assert.equal(h.host.fixtures.length, 2);
    assert.deepEqual(h.host.dockerRequests().filter(request => request.exec).map(request => request.exec), ['bridge'], 'no check ran');
    assert.equal(h.store.rows.length, 1);
  });

  it('needs no check for an image the seed catalog lists', async t => {
    const h = unqualified(t, { seeded: true });
    assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
    assert.deepEqual(h.host.dockerRequests().filter(request => request.exec).map(request => request.exec), ['bridge']);
    assert.equal(h.store.rows.length, 0);
  });

  for (const [name, answer, check] of [
    ['a missing /bin/bash', syntheticBeeBridgeCheckAnswer({ missing: ['bash'] }), 'bash'],
    ['a bash without /dev/tcp', syntheticBeeBridgeCheckAnswer({ devTcp: 'missing' }), 'dev_tcp'],
    ['an unreadable answer', 'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory', 'answer'],
  ] as const) {
    it(`refuses ${name} with the check named, stores the failure, and sends nothing to Bee`, async t => {
      const h = unqualified(t, { checkAnswer: answer });
      await assert.rejects(h.service.submit(transferIntent()), error => {
        assert.ok(error instanceof ChequebookPreparationError);
        assert.deepEqual(error.refusal, { cause: 'bridge_not_qualified', check });
        return true;
      });
      assert.deepEqual(h.store.rows.map(row => row.failedCheck), [check]);
      assert.deepEqual(h.host.dockerRequests().filter(request => request.exec).map(request => request.exec), ['check'], 'no bridge exec');
      assert.deepEqual(h.host.beeRequests(), [], 'no Bee request');
      assert.equal(h.host.posts(), 0, 'no send');
      assert.equal(h.repository.rows.size, 0, 'nothing admitted');
    });
  }

  it('checks again on a later attempt, and a pass then lets the transfer through', async t => {
    const failing = unqualified(t, { checkAnswer: syntheticBeeBridgeCheckAnswer({ missing: ['cat'] }) });
    await assert.rejects(failing.service.submit(transferIntent()));
    const passing = unqualified(t);
    passing.store.rows.push(...failing.store.rows);
    assert.equal((await passing.service.submit(transferIntent())).operation.state, 'submitted');
    assert.deepEqual(passing.store.rows.map(row => row.failedCheck), ['cat', null]);
  });

  it('refuses when the bridge\'s own read finds another image than the one that was checked', async t => {
    const replaced = `sha256:${'f'.repeat(64)}`;
    let reads = 0;
    const h = unqualified(t, { answer: path => {
      if (path === `/images/${replaced}/json`) return { body: { Id: replaced, Os: 'linux', Architecture: 'amd64' } };
      if (path !== `/containers/${syntheticContainerId}/json` || ++reads === 1) return undefined;
      return { body: { ...syntheticContainerInspect(), Image: replaced } };
    } });
    await assert.rejects(h.service.submit(transferIntent()), error => error instanceof ChequebookPreparationError && error.refusal.cause === 'target_changed');
    assert.deepEqual(h.host.dockerRequests().filter(request => request.exec).map(request => request.exec), ['check']);
    assert.equal(h.host.posts(), 0);
  });

  it('checks a remote host\'s image through one ssh forward and two connections through it', async t => {
    const h = unqualified(t, { alias: 'bee-eu-1', ssh: true });
    assert.equal((await h.service.submit(transferIntent())).operation.state, 'submitted');
    assert.equal(h.remote.events.filter(event => event === 'spawn').length, 1, 'one forward');
    assert.equal(h.host.fixtures.length, 2, 'two connections through it');
    assert.equal(h.store.rows[0]!.hostAlias, 'bee-eu-1');
    assert.equal(h.host.posts(), 1);
  });

  it('lets two first transfers racing on a new image both check and keeps one pass', async t => {
    // Holds every write until both probes have asked for a pass, so both find none and both check.
    class BothReadFirst extends InMemoryBeeBridgeQualifications {
      reads = 0; readersArrived!: () => void; bothRead = new Promise<void>(resolve => { this.readersArrived = resolve; });
      override async passFor(...args: Parameters<InMemoryBeeBridgeQualifications['passFor']>) {
        if (++this.reads === 2) this.readersArrived();
        return super.passFor(...args);
      }
      override async record(...args: Parameters<InMemoryBeeBridgeQualifications['record']>) { await this.bothRead; return super.record(...args); }
    }
    const shared = new BothReadFirst();
    const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
    const hosts = [syntheticDockerHost(t), syntheticDockerHost(t)];
    const services = hosts.map(host => createChequebookOperationsService(pool, { rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: undefined }, {
      repository: new InMemoryChequebookOperations(), bridgeQualifications: shared, captureTarget: async () => onHost('localhost'),
      createChainReader: () => chainReader, connectUnix: host.connect, preparation: { cleanupGraceMs: 20, timeoutMs: 3000 } }));
    for (const service of services) t.after(() => service.shutdown());
    const results = await Promise.all(services.map(service => service.submit(transferIntent())));
    assert.deepEqual(results.map(result => result.operation.state), ['submitted', 'submitted']);
    assert.equal(hosts.flatMap(host => host.dockerRequests()).filter(request => request.exec === 'check').length, 2, 'both checked');
    assert.equal(shared.rows.filter(row => row.failedCheck === null).length, 1, 'one pass landed');
  });
});
