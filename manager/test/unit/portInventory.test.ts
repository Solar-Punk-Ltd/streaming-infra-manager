import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PortInventory } from '../../src/domain/ports/PortInventory.js';
import type { PublishedPortsSnapshot } from '../../src/domain/ports/PublishedPortsProbe.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';
import { makeProfile } from '../support/profileFixtures.js';

function setup() {
  const h = profileServiceHarness([
    makeProfile({ name: 'old', port_slot: 4, status: 'STOPPED' }),
  ]);
  h.profiles.reservations.seededAt = null;
  const snapshot: PublishedPortsSnapshot = {
    daemonId: 'daemon-1',
    bindings: [{ project: 'old', service: 'srs', protocol: 'tcp', port: 12345 }],
  };
  const targets = { daemonIdFor: async () => 'daemon-1' };
  return { h, snapshot, targets };
}

describe('seeding the reservation inventory', () => {
  it('keeps existing slots and stopped records, reserving both the contract and observed old bindings', async () => {
    const { h, snapshot, targets } = setup();
    const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets,
      { publishedPorts: async () => snapshot });
    await inventory.seed();
    const held = await h.profiles.reservations.listByProfile('old');
    assert.equal(h.profiles.rows.get('old')!.port_slot, 4);
    assert.equal(h.profiles.rows.get('old')!.status, 'STOPPED');
    assert.ok(held.some((row) => row.port === 10042 && row.state === 'planned'));
    assert.ok(held.some((row) => row.port === 12345 && row.state === 'active'));
    assert.ok(await h.profiles.reservations.inventorySeededAt());
    assert.equal(h.orchestrator.deploys.length, 0);
  });

  it('keeps new allocation gated until the complete observation has been reserved', async () => {
    const { h, snapshot, targets } = setup();
    let finish!: (snapshot: PublishedPortsSnapshot) => void;
    const observed = new Promise<PublishedPortsSnapshot>((resolve) => { finish = resolve; });
    const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets,
      { publishedPorts: () => observed });
    const seeding = inventory.seed();
    await assert.rejects(h.service.create({ name: 'new', kind: 'viewer' }), /inventory is still being built/);
    finish(snapshot);
    await seeding;
    await h.service.create({ name: 'new', kind: 'viewer' });
    assert.equal(h.profiles.rows.get('old')!.port_slot, 4);
  });

  it('retains the gate on a failed or wrong-daemon observation', async () => {
    for (const wrongDaemon of [false, true]) {
      const { h, snapshot, targets } = setup();
      const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets, {
        publishedPorts: async () => {
          if (!wrongDaemon) throw new Error('unreachable');
          return { ...snapshot, daemonId: 'another-daemon' };
        },
      });
      await assert.rejects(inventory.seed());
      assert.equal(await h.profiles.reservations.inventorySeededAt(), null);
    }
  });

  it('resumes a partial seed without duplicating rows or releasing any held port', async () => {
    const { h, snapshot, targets } = setup();
    let fails = true;
    const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets, {
      publishedPorts: async () => { if (fails) throw new Error('unreachable'); return snapshot; },
    });
    await assert.rejects(inventory.seed());
    fails = false;
    await inventory.seed();
    const once = [...h.profiles.reservations.rows];
    await inventory.seed();
    assert.deepEqual(h.profiles.reservations.rows, once);
  });

  it('blocks allocation over a port published by a container without a manager profile', async () => {
    const { h, targets } = setup();
    const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets, {
      publishedPorts: async () => ({
        daemonId: 'daemon-1',
        bindings: [{ project: 'outside', service: 'web', protocol: 'tcp', port: 10012 }],
      }),
    });
    await inventory.seed();
    const created = await h.service.create({ name: 'new', kind: 'viewer' });
    assert.equal(created.port_slot, 2, 'slot 1 RTMP belongs to the outside container');
  });

  it('refuses a seed when existing deployments claim the same physical port', async () => {
    const { h, snapshot, targets } = setup();
    h.profiles.rows.set('duplicate', makeProfile({ name: 'duplicate', port_slot: 4 }));
    const inventory = new PortInventory(h.profiles.asRepository(), h.versions, h.profiles.reservations, targets,
      { publishedPorts: async () => snapshot });
    await assert.rejects(inventory.seed(), /old|duplicate/);
    assert.equal(await h.profiles.reservations.inventorySeededAt(), null);
  });
});
