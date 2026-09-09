import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runManagerUpgrade, type ManagerUpgradeOperations, type ManagerUpgradeRequest } from '../../src/domain/versions/ManagerUpgrade.js';
import type { BundledShipmentReceipt } from '../../src/domain/versions/BundledShipment.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40);
function request(id = '11111111-1111-4111-8111-111111111111', commit = A): ManagerUpgradeRequest {
  return { shipment: { shipmentId: id, commit, digest: 'd'.repeat(64) },
    manager: { sourceCommit: commit, sourceDigest: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}` }, project: 'manager' };
}
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

describe('one manager upgrade owns every active project mutation', () => {
  let root: string; let environment: { guardRoot: string; mutableRoot: string };
  let current: { revision: string; buildId: string | null }; let receipts: Map<string, BundledShipmentReceipt>;
  let actions: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-')); environment = { guardRoot: join(root, 'upgrade-owner'), mutableRoot: join(root, 'manager') };
    current = { revision: '0', buildId: null }; receipts = new Map(); actions = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function operations(): ManagerUpgradeOperations {
    return {
      readPublication: async input => ({ ...current, receipt: receipts.get(input.shipment.shipmentId) ?? null }),
      stopApi: async () => { actions.push('stop-api'); },
      installSources: async () => { actions.push('install-source-and-config'); },
      publish: async input => {
        actions.push('publish');
        const receipt = { shipmentId: input.shipment.shipmentId, versionId: 1, buildId: input.shipment.commit,
          publicationRevision: String(BigInt(current.revision) + 1n), publishedAt: new Date(0) };
        receipts.set(receipt.shipmentId, receipt); current = { revision: receipt.publicationRevision, buildId: receipt.buildId };
        return receipt;
      },
      startProject: async () => { actions.push('start-api-web-edge'); },
      verifyProject: async () => { actions.push('verify-project'); },
    };
  }
  it('persists exact identity and the phase before each effect, then releases only after verification', async () => {
    const input = request(); const ops = operations();
    for (const [method, phase] of [['stopApi', 'stopping'], ['installSources', 'installing'], ['publish', 'publishing'],
      ['startProject', 'starting'], ['verifyProject', 'verifying']] as const) {
      const original = ops[method];
      Object.assign(ops, { [method]: async (captured: ManagerUpgradeRequest) => {
        const recorded = JSON.parse(await readFile(join(environment.guardRoot, 'owner.json'), 'utf8'));
        assert.deepEqual(recorded.request, input); assert.equal(recorded.phase, phase);
        return original(captured);
      } });
    }
    const result = await runManagerUpgrade(environment, input, ops);
    assert.equal(result.state, 'completed');
    assert.deepEqual(actions, ['stop-api', 'install-source-and-config', 'publish', 'start-api-web-edge', 'verify-project']);
    assert.equal((await readdir(root)).includes('upgrade-owner'), false);
  });

  it('keeps A ownership through startup so C cannot install sources, publish or change any service', async () => {
    const entered = signal(); const release = signal(); const aOps = operations();
    aOps.startProject = async () => { actions.push('A-start-held'); entered.resolve(); await release.promise; };
    const running = runManagerUpgrade(environment, request(), aOps);
    try {
      await entered.promise; const before = [...actions];
      await assert.rejects(runManagerUpgrade(environment, request('22222222-2222-4222-8222-222222222222', B), operations()), /upgrade.*owned|upgrade.*progress/i);
      assert.deepEqual(actions, before);
    } finally { release.resolve(); await running; }
  });

  it('refuses stale A after C completed and released its guard, before any manager mutation', async () => {
    const a = request(); const c = request('22222222-2222-4222-8222-222222222222', B);
    await runManagerUpgrade(environment, a, operations());
    await runManagerUpgrade(environment, c, operations());
    actions = [];
    await assert.rejects(runManagerUpgrade(environment, a, operations()), /stale|current publication/i);
    assert.deepEqual(actions, []); assert.equal(current.buildId, B);
  });

  it('returns an already verified current upgrade without reinstalling or restarting it', async () => {
    const input = request(); await runManagerUpgrade(environment, input, operations()); actions = [];
    assert.equal((await runManagerUpgrade(environment, input, operations())).state, 'already-completed');
    assert.deepEqual(actions, []);
  });

  it('does not release or steal uncertain ownership on a same-ID retry, even with an old timestamp', async () => {
    const input = request(); const ops = operations();
    ops.startProject = async () => { actions.push('uncertain-start'); throw new Error('synthetic command response loss'); };
    await assert.rejects(runManagerUpgrade(environment, input, ops), /response loss/);
    const before = await readFile(join(environment.guardRoot, 'owner.json'));
    await utimes(environment.guardRoot, new Date(0), new Date(0)); actions = [];
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /upgrade.*owned|upgrade.*progress/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readFile(join(environment.guardRoot, 'owner.json')), before);
  });

  it('refuses a changed exact manager identity on replay of a completed shipment', async () => {
    const input = request(); await runManagerUpgrade(environment, input, operations()); actions = [];
    input.manager.imageId = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /identity/i);
    assert.deepEqual(actions, []);
  });

  it('allows a fresh explicitly requested shipment after a completed upgrade', async () => {
    await runManagerUpgrade(environment, request(), operations()); actions = [];
    const next = request('22222222-2222-4222-8222-222222222222', B);
    assert.equal((await runManagerUpgrade(environment, next, operations())).state, 'completed');
    assert.equal(current.buildId, B); assert.equal(actions.length, 5);
  });

  it('freezes caller identity before asynchronous publication reads', async () => {
    const input = request(); const original = structuredClone(input); const ops = operations(); const read = ops.readPublication;
    ops.readPublication = async selected => { input.manager.imageId = `sha256:${'0'.repeat(64)}`; return read(selected); };
    ops.stopApi = async selected => { assert.deepEqual(selected, original); };
    await runManagerUpgrade(environment, input, ops);
  });

  it('refuses a guard placed within the mutable installation destination', async () => {
    await assert.rejects(runManagerUpgrade({ ...environment, guardRoot: join(environment.mutableRoot, '.upgrade') }, request(), operations()), /outside|overlap/i);
    assert.deepEqual(actions, []);
  });

  it('rejects unexpected request fields before persisting any record', async () => {
    const input = { ...request(), unexpectedPrivateInput: 'synthetic-do-not-record' };
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /identity|fields/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readdir(root), []);
  });

  it('rejects unexpected nested identity fields before acquiring ownership', async () => {
    const input = request(); Object.assign(input.manager, { unexpectedPrivateInput: 'synthetic-do-not-record' });
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /identity|fields/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readdir(root), []);
  });

  it('refuses ancestor aliases and a linked completion archive without touching their targets', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); const alias = join(root, 'alias'); await symlink(outside, alias);
    await assert.rejects(runManagerUpgrade({ ...environment, guardRoot: join(alias, 'guard') }, request(), operations()));
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(actions, []);
    await symlink(outside, `${environment.guardRoot}.completed`);
    await assert.rejects(runManagerUpgrade(environment, request(), operations()));
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(actions, []);
  });
});
