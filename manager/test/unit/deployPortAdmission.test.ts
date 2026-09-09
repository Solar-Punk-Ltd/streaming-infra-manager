import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { StackContract } from '@streaming-infra-manager/common';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';

const root = mkdtempSync(join(tmpdir(), 'deploy-port-admission-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

function contract(base: number): StackContract {
  return { ...structuredClone(ALLOCATION_CONTRACT), ports: [
    { name: 'RTMP_PORT', defaultPort: base, slotBase: base, protocol: 'tcp', service: 'srs' },
    { name: 'HTTP_PORT', defaultPort: base + 1, slotBase: base + 1, protocol: 'tcp', service: 'stream-uploader' },
  ] };
}

async function setup() {
  const h = orchestratorHarness([makeProfile({ name: 'a', port_slot: 1, components: ['srs'], stamp_id: null })]);
  const old = contract(10000);
  await h.versions.markBuilt(1, { commitSha: 'old', contract: old });
  await h.profiles.reservations.plan('daemon-1', 'a', portPlanFor(old.ports, 1), 'old active build');
  await h.profiles.reservations.setState(h.profiles.reservations.rows.map(r => r.id), 'active');
  return { ...h, row: () => h.profiles.rows.get('a')!, ports: h.profiles.reservations };
}

describe('captured contract port admission', () => {
  it('reserves the actual OME service from the captured alias contract', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'a', port_slot: 1, components: ['ome'] })]);
    const table = structuredClone(ALLOCATION_CONTRACT);
    table.portAliases = ['SRS_SRT_PORT', 'SRS_HTTP_PORT'].map((source, index) => ({
      ...table.ports.find(port => port.name === source)!, name: index === 0 ? 'OME_SRT_PORT' : 'OME_HLS_PORT', service: 'ome',
    }));
    await h.versions.markBuilt(1, { commitSha: 'OME', contract: table });
    await h.orchestrator.reserveDeploy(h.profiles.rows.get('a')!, ['ome']);
    assert.deepEqual(h.profiles.reservations.rows.find(row => row.port === 10011)?.heldServices, ['ome']);
    assert.deepEqual(h.profiles.reservations.rows.find(row => row.port === 10013)?.heldServices, ['ome']);
  });

  for (const base of [11002, 20000]) {
    it(`refuses private port mappings at ${base + 10} before reserving or launching`, async () => {
      const h = await setup();
      await h.versions.markBuilt(1, { commitSha: 'unsafe', contract: contract(base) });
      await assert.rejects(h.orchestrator.startDeploy(h.row(), ['srs']), /public|protected/);
      assert.equal(h.runner.runs.length, 0);
      assert.deepEqual(h.ports.rows.map(row => row.port), [10010, 10011]);
      assert.deepEqual(h.ledger.openJobReferences('a'), []);
    });
  }

  it('cancels only the current unstarted build reference when port admission is refused', async () => {
    const h = await setup();
    const old = await h.ledger.seedJob('a', await h.versions.findById(1), ['srs', 'stream-uploader']);
    await h.versions.markBuilt(1, { commitSha: 'new', contract: contract(13000) });
    await h.ports.plan('daemon-1', 'b', portPlanFor(contract(13000).ports, 1), 'conflict');
    await assert.rejects(h.orchestrator.reserveDeploy(h.row(), undefined), /b holds/);
    assert.deepEqual(h.ledger.openJobReferences('a').map(reference => reference.id), [old.referenceId]);
    assert.equal(h.row().status, 'RUNNING');
  });

  it('adds the entire captured table while keeping old active ports until observed release', async () => {
    const h = await setup();
    await h.versions.markBuilt(1, { commitSha: 'new', contract: contract(13000) });
    await h.orchestrator.reserveDeploy(h.row(), ['srs']);
    assert.deepEqual(h.ports.rows.map(r => [r.port, r.state]), [
      [10010, 'active'], [10011, 'active'], [13010, 'planned'], [13011, 'planned'],
    ]);
    await assert.rejects(h.ports.plan('daemon-1', 'b', [{ protocol: 'tcp', port: 10010, service: 'srs', portVar: 'RTMP_PORT' }], 'other'), /a holds/);
  });

  it('refuses a conflicting new table and restores the claim without starting a script', async () => {
    const h = await setup();
    await h.versions.markBuilt(1, { commitSha: 'new', contract: contract(13000) });
    await h.ports.plan('daemon-1', 'b', portPlanFor(contract(13000).ports, 1), 'other');
    await assert.rejects(h.orchestrator.reserveDeploy(h.row(), ['srs']), /b holds/);
    assert.equal(h.row().status, 'RUNNING');
    assert.equal(h.runner.runs.length, 0);
    assert.deepEqual((await h.ports.listByProfile('a')).map(r => r.port), [10010, 10011]);
  });

  it('uses X for reservation and launch after Y is published', async () => {
    const h = await setup();
    await h.versions.markBuilt(1, { commitSha: 'X', contract: contract(13000) });
    const reserved = await h.orchestrator.reserveDeploy(h.row(), ['srs']);
    await h.versions.markBuilt(1, { commitSha: 'Y', contract: contract(14000) });
    await h.orchestrator.runReserved(reserved, h.row());
    assert.equal(reserved.build?.version?.commitSha, 'X');
    assert.deepEqual(h.ports.rows.map(r => r.port), [10010, 10011, 13010, 13011]);
    assert.equal(h.runner.runs.length, 1);
  });

  it('keeps both tables after a failed recreate', async () => {
    const h = await setup();
    await h.versions.markBuilt(1, { commitSha: 'new', contract: contract(13000) });
    await h.orchestrator.startDeploy(h.row(), ['srs']);
    h.daemon.autoRecreate = false;
    const failed = new Promise<void>(resolve => h.events.subscribe(event => {
      if (event.type === 'profile.changed' && event.profile.status === 'ERROR') resolve();
    }));
    h.runner.finish(0, 1);
    await failed;
    assert.deepEqual(h.ports.rows.map(r => [r.port, r.state]), [
      [10010, 'active'], [10011, 'active'], [13010, 'planned'], [13011, 'planned'],
    ]);
  });

  for (const missing of ['empty', 'absent', 'unparseable', 'inventory'] as const) {
    it(`refuses ${missing} port evidence before launch`, async () => {
      const h = await setup();
      const version = (await h.versions.findById(1))!;
      if (missing === 'empty') version.contract = { ...contract(13000), ports: [] };
      if (missing === 'absent') version.contract = null;
      if (missing === 'unparseable') version.contract = { ...contract(13000), allocationProblem: 'unknown mapping' };
      if (missing === 'inventory') h.ports.seededAt = null;
      await assert.rejects(h.orchestrator.startDeploy(h.row(), ['srs']), /port table|unknown mapping|inventory/);
      assert.equal(h.runner.runs.length, 0);
      assert.equal(h.row().status, 'RUNNING');
    });
  }

  it('revalidates initial deploy against the build captured after allocation', async () => {
    const h = await setup();
    h.profiles.write('a', { status: 'DEPLOYING' });
    await h.versions.markBuilt(1, { commitSha: 'new', contract: contract(13000) });
    await h.ports.plan('daemon-1', 'b', portPlanFor(contract(13000).ports, 1), 'other');
    await assert.rejects(h.orchestrator.startInitialDeploy(h.row(), ['srs']), /b holds/);
    assert.equal(h.runner.runs.length, 0);
    assert.deepEqual(h.ledger.openJobReferences('a'), []);
  });

  it('refuses a changed daemon between reservation and launch', async () => {
    const h = await setup();
    const reserved = await h.orchestrator.reserveDeploy(h.row(), ['srs']);
    h.daemon.id = 'replacement-daemon';
    await assert.rejects(h.orchestrator.runReserved(reserved, h.row()), /different Docker daemon/);
    assert.equal(h.runner.runs.length, 0);
    assert.ok(h.ports.rows.every(r => r.daemonId === 'daemon-1'));
  });
});
