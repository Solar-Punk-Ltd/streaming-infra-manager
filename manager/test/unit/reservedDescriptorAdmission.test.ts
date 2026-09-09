import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { StackContract } from '@streaming-infra-manager/common';
import type { DeployReservation } from '../../src/domain/DeploymentOrchestrator.js';
import { DeployAttemptRefusedError } from '../../src/domain/errors/index.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const root = mkdtempSync(join(tmpdir(), 't06-descriptor-admission-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

function contract(base: number): StackContract {
  return { ...structuredClone(ALLOCATION_CONTRACT), ports: [
    { name: 'RTMP_PORT', defaultPort: base, slotBase: base, protocol: 'tcp', service: 'srs' },
  ] };
}

async function setup(services = ['srs']) {
  const profile = makeProfile({ name: 'reserved', status: 'DEPLOYING', host: 'localhost', components: ['srs'] });
  const h = orchestratorHarness([profile]);
  await h.versions.markBuilt(1, { commitSha: 'A', contract: contract(19000) });
  const reservation: DeployReservation = {
    profileName: profile.name, services, heldBackForStamp: [], previousStatus: 'RUNNING',
    transitioned: true, host: 'edge', build: null,
  };
  h.daemon.daemonId = async (target = 'localhost') => target === 'edge' ? 'edge-daemon' : 'local-daemon';
  return { ...h, profile, reservation };
}

describe('a reserved deployment captures its build before port work', () => {
  for (const services of [[], ['srs']]) {
    it(`uses one captured descriptor for target, ports and ${services.length ? 'launch' : 'no-op'} without rereading`, async () => {
      const h = await setup(services);
      const describe = h.ledger.describe.bind(h.ledger);
      let descriptions = 0;
      h.ledger.describe = async (...args) => {
        descriptions += 1;
        const build = await describe(...args);
        await h.versions.markBuilt(1, { commitSha: 'B', contract: contract(20000) });
        h.versions.findById = async () => { throw new Error('version reread after capture'); };
        return build;
      };
      await h.orchestrator.runReserved(h.reservation, h.profile);
      assert.equal(descriptions, 1);
      const ports = await h.profiles.reservations.listByProfile(h.profile.name);
      assert.deepEqual(ports.map(port => [port.daemonId, port.port]), [['edge-daemon', 19010]]);
      assert.equal(h.runner.runs.length, services.length ? 1 : 0);
      if (services.length) {
        assert.ok(h.runner.runs[0]?.args.includes('--host=edge'));
        assert.equal(h.attempts.rows[0]?.target, 'edge');
        assert.equal(h.attempts.rows[0]?.daemonId, 'edge-daemon');
      } else {
        assert.equal(h.profiles.statusOf(h.profile.name), 'RUNNING');
      }
    });
  }

  it('uses an already captured reservation without describing it again', async () => {
    const h = await setup();
    const build = await h.ledger.seedJob(h.profile.name, await h.versions.findById(1), ['srs']);
    h.ledger.describe = async () => { throw new Error('duplicate description'); };
    h.versions.findById = async () => { throw new Error('version reread after capture'); };
    await h.orchestrator.runReserved({ ...h.reservation, build }, h.profile);
    assert.equal(h.runner.runs.length, 1);
    assert.deepEqual((await h.profiles.reservations.listByProfile(h.profile.name)).map(port => port.port), [19010]);
  });

  for (const captured of [false, true]) {
    it(`resolves only the successful no-op's ${captured ? 'captured' : 'fallback'} reference and keeps its ports`, async () => {
      const h = await setup([]);
      const version = await h.versions.findById(1);
      const older = await h.ledger.seedJob(h.profile.name, version, ['srs', 'stream-uploader']);
      const build = captured ? await h.ledger.seedJob(h.profile.name, version, []) : null;

      await h.orchestrator.runReserved({ ...h.reservation, build }, h.profile);

      assert.deepEqual(h.ledger.openJobReferences(h.profile.name).map(reference => reference.id), [older.referenceId]);
      const newer = h.ledger.references.find(reference => reference.id !== older.referenceId);
      assert.ok(newer?.resolvedAt, 'the successful no-op releases its own unstarted reference');
      assert.deepEqual((await h.profiles.reservations.listByProfile(h.profile.name)).map(port => [port.daemonId, port.port]), [['edge-daemon', 19010]]);
      assert.equal(h.profiles.statusOf(h.profile.name), 'RUNNING');
      assert.equal(h.runner.runs.length, 0);
      assert.equal(h.attempts.rows.length, 0);
    });
  }

  it('cancels only the new fallback reference when port admission fails', async () => {
    const h = await setup();
    const older = await h.ledger.seedJob(h.profile.name, await h.versions.findById(1), ['srs', 'stream-uploader']);
    await h.profiles.reservations.plan('edge-daemon', 'other', portPlanFor(contract(19000).ports, 1), 'existing holder');
    await assert.rejects(h.orchestrator.runReserved(h.reservation, h.profile), /other holds/);
    assert.deepEqual(h.ledger.openJobReferences(h.profile.name).map(reference => reference.id), [older.referenceId]);
    const newer = h.ledger.references.find(reference => reference.id !== older.referenceId);
    assert.ok(newer?.resolvedAt, 'the newly described fallback was cancelled');
    assert.equal(h.runner.runs.length, 0);
    assert.equal(h.profiles.statusOf(h.profile.name), 'ERROR');
  });

  it('restores the prior status and cancels only this reference on a late creation-guard refusal', async () => {
    const h = await setup();
    const older = await h.ledger.seedJob(h.profile.name, await h.versions.findById(1), ['srs', 'stream-uploader']);
    h.attempts.open = async () => { throw new DeployAttemptRefusedError(h.profile.name, 'another attempt won'); };
    await assert.rejects(h.orchestrator.runReserved(h.reservation, h.profile), /another attempt won/);
    assert.deepEqual(h.ledger.openJobReferences(h.profile.name).map(reference => reference.id), [older.referenceId]);
    assert.equal(h.profiles.statusOf(h.profile.name), 'RUNNING');
    assert.equal(h.runner.runs.length, 0);
  });

  it('retains the fallback reference if the runner invocation has an uncertain launch outcome', async () => {
    const h = await setup();
    h.runner.run = () => { throw new Error('unknown launch outcome'); };
    await assert.rejects(h.orchestrator.runReserved(h.reservation, h.profile), /unknown launch outcome/);
    assert.equal(h.ledger.openJobReferences(h.profile.name).length, 1);
    assert.equal(h.attempts.rows.length, 1);
    assert.equal(h.profiles.statusOf(h.profile.name), 'ERROR');
  });
});
