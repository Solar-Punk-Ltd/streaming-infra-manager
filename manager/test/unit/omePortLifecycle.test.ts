import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OME_PORT_SOURCES } from '@streaming-infra-manager/common';
import { PortInventory } from '../../src/domain/ports/PortInventory.js';
import { PortHandover } from '../../src/domain/ports/PortHandover.js';
import { portTableForEngine } from '../../src/domain/versions/enginePortTable.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';
import { makeProfile } from '../support/profileFixtures.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { FakeDaemon, InMemoryDeployAttempts } from '../support/InMemoryDeployAttempts.js';

function omeContract() {
  const contract = structuredClone(ALLOCATION_CONTRACT);
  contract.portAliases = Object.entries(OME_PORT_SOURCES).map(([name, source]) => ({
    ...contract.ports.find(port => port.name === source)!, name, service: 'ome',
  }));
  return contract;
}

describe('OME port lifecycle', () => {
  for (const action of ['deployment', 'group', 'member'] as const) {
    it(`reserves OME ownership for a new ${action}`, async () => {
      const h = profileServiceHarness();
      (await h.versions.findDefault())!.contract = omeContract();
      if (action === 'deployment') {
        await h.service.create({ name: 'stage', kind: 'custom', components: ['ome'] });
      } else {
        const { group } = await h.service.createGroup({ group_name: 'pool', size: 1, kind: 'custom', components: ['ome'] });
        if (action === 'member') {
          for (const profile of h.profiles.rows.values()) h.profiles.write(profile.name, { status: 'RUNNING' });
          await h.service.addGroupMembers(group.id, 1);
        }
      }
      for (const profile of h.profiles.rows.values()) {
        const rows = await h.profiles.reservations.listByProfile(profile.name);
        for (const [protocol, base] of [['udp', 10001], ['tcp', 10003]] as const) {
          assert.deepEqual(rows.find(row => row.protocol === protocol && row.port === base + profile.port_slot * 10)?.heldServices, ['ome']);
        }
      }
    });
  }

  it('seeds OME ports without renumbering a stopped deployment', async () => {
    const h = profileServiceHarness([makeProfile({ name: 'a', port_slot: 1, status: 'STOPPED', components: ['ome'] })]);
    (await h.versions.findDefault())!.contract = omeContract();
    h.profiles.reservations.seededAt = null;
    await new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations,
      { daemonIdFor: async () => 'daemon-1' },
      { publishedPorts: async () => ({ daemonId: 'daemon-1', bindings: [] }) }).seed();
    assert.deepEqual(h.profiles.reservations.rows.find(row => row.port === 10011)?.heldServices, ['ome']);
    assert.equal(h.profiles.rows.get('a')!.status, 'STOPPED');
  });

  for (const observation of ['complete', 'missing-HLS', 'wrong-owner'] as const) {
    it(`requires both OME bindings before retiring old OME ports: ${observation}`, async () => {
      const h = profileServiceHarness();
      const contract = omeContract();
      const version = (await h.versions.findDefault())!;
      version.contract = contract;
      const ports = h.profiles.reservations;
      await ports.plan('daemon-1', 'a', [
        { protocol: 'udp', port: 13001, service: 'ome', portVar: 'OME_SRT_PORT' },
        { protocol: 'tcp', port: 13003, service: 'ome', portVar: 'OME_HLS_PORT' },
        { protocol: 'tcp', port: 13000, service: 'stream-uploader', portVar: 'API_PORT' },
      ], 'old');
      const plan = portPlanFor(portTableForEngine(contract, 'ome'), 1);
      await ports.plan('daemon-1', 'a', plan, 'new');
      const daemon = new FakeDaemon();
      daemon.set('a', 'ome', ['new-ome']);
      const attempt = await new InMemoryDeployAttempts().open({ daemonId: 'daemon-1', project: 'a', target: 'localhost',
        jobId: 'new-job', kind: 'fixed', services: ['ome'], preJobContainerIds: ['old-ome'] });
      const bindings = plan.filter(port => port.service === 'ome' && (observation !== 'missing-HLS' || port.protocol === 'udp'))
        .map(port => ({ ...port, project: 'a', service: observation === 'wrong-owner' ? 'srs' : 'ome' }));
      await new PortHandover(ports, { publishedPorts: async () => ({ daemonId: 'daemon-1', bindings }) }, daemon)
        .reconcile(makeProfile({ name: 'a', port_slot: 1, status: 'DEPLOYING', components: ['ome'] }),
          { version, buildId: 'new', referenceId: 42, root: '/fake/build' }, attempt);
      const retained = (await ports.listByProfile('a')).map(row => row.port);
      assert.equal(retained.includes(13001), observation !== 'complete');
      assert.equal(retained.includes(13003), observation !== 'complete');
      assert.ok(retained.includes(13000), 'untouched uploader remains reserved');
    });
  }
});
