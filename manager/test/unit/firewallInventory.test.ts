import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FirewallInventoryExporter } from '../../src/domain/ports/FirewallInventoryExporter.js';
import type { FirewallState } from '../../src/domain/ports/firewallInventoryTypes.js';
import type { StackPortVar } from '@streaming-infra-manager/common';
import type { PublishedPortsSnapshot } from '../../src/domain/ports/PublishedPortsProbe.js';

function setup() {
  const peer: StackPortVar = { name: 'BEE_RUNG_480P_P2P_PORT', slotBase: 11002, defaultPort: 11002, protocol: 'tcp', service: 'bee-uploader-480p' };
  const state: FirewallState = {
    inventoryReady: true, seededDaemons: ['daemon'],
    targets: [{ alias: 'localhost', daemonId: 'daemon', verified: true }],
    profiles: [{ name: 'a', slot: 1, status: 'STOPPED', target: 'localhost', versionId: 1 }],
    versions: [{ id: 1, name: 'v3', layout: 'builds', rootPath: '/fake/v3', buildId: 'a'.repeat(40), previousBuildId: null }],
    references: [], attempts: [],
    reservations: [{ daemonId: 'daemon', profileName: 'a', port: 11012, protocol: 'tcp', heldServices: ['bee-uploader-480p'] }],
  };
  const snapshot: PublishedPortsSnapshot = { daemonId: 'daemon', bindings: [] };
  const contracts = new Map([['a'.repeat(40), [peer]]]);
  let reads = 0;
  let changeOnSecondRead = false;
  const exporter = new FirewallInventoryExporter({ read: async () => {
    const value = structuredClone(state);
    if (++reads === 2 && changeOnSecondRead) value.profiles[0]!.slot = 2;
    return value;
  } }, { daemonId: async () => 'daemon', publishedPorts: async () => snapshot }, {
    read: async (_version, buildId) => {
      const ports = contracts.get(buildId);
      if (!ports) throw new Error('missing immutable build');
      return { ports, maxSlot: 99, allocationProblem: null };
    },
  });
  return { state, snapshot, peer, contracts, exporter, change: () => { changeOnSecondRead = true; } };
}

describe('firewall evidence export', () => {
  it('includes stopped profiles and retained snapshot builds with the verified daemon identity', async () => {
    const h = setup();
    const oldId = 'b'.repeat(40);
    h.contracts.set(oldId, [{ ...h.peer, name: 'BEE_API_PORT', service: 'bee-uploader', slotBase: 13000 }]);
    h.state.references.push({ versionId: 1, buildId: oldId, holderKind: 'snapshot', holderId: 'a/bee-uploader', services: ['bee-uploader'] });
    h.state.reservations.push({ daemonId: 'daemon', profileName: 'a', port: 13010, protocol: 'tcp', heldServices: ['bee-uploader'] });
    const result = await h.exporter.export('localhost');
    assert.equal(result.daemonId, 'daemon');
    assert.equal(result.profiles[0]!.name, 'a');
    assert.ok(result.claims.some(claim => claim.port === 13010 && claim.buildId === oldId));
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('refuses a retained private role on a currently public peer tuple', async () => {
    const h = setup();
    h.state.versions[0]!.previousBuildId = 'b'.repeat(40);
    h.contracts.set('b'.repeat(40), [{ ...h.peer, name: 'SRS_RTMP_PORT', service: 'srs' }]);
    await assert.rejects(h.exporter.export('localhost'), /a.*11012.*public/);
  });

  it('refuses existing bundled slot 101 without renumbering or deleting its record', async () => {
    const h = setup();
    h.state.profiles[0]!.slot = 101;
    h.contracts.set('a'.repeat(40), [{ ...h.peer, name: 'SRS_RTMP_PORT', service: 'srs', slotBase: 10002 }]);
    await assert.rejects(h.exporter.export('localhost'), /a.*11012.*public/);
    assert.equal(h.state.profiles[0]!.slot, 101);
  });

  for (const missing of ['seed', 'legacy', 'build', 'owner', 'reference', 'binding', 'target', 'host-network'] as const) {
    it(`refuses incomplete ${missing} evidence`, async () => {
      const h = setup();
      if (missing === 'seed') h.state.seededDaemons = [];
      if (missing === 'legacy') h.state.versions[0]!.layout = 'legacy';
      if (missing === 'build') h.contracts.clear();
      if (missing === 'owner') h.state.reservations[0]!.heldServices = [null];
      if (missing === 'reference') h.state.reservations[0]!.port = 13010;
      if (missing === 'binding') h.snapshot.bindings = [{ project: 'outside', service: 'web', protocol: 'tcp', port: 11012 }];
      if (missing === 'target') h.state.targets[0]!.verified = false;
      if (missing === 'host-network') h.snapshot.unverifiedProjects = ['outside'];
      await assert.rejects(h.exporter.export('localhost'));
    });
  }

  for (const busy of ['job', 'operation', 'attempt', 'status'] as const) {
    it(`refuses an unresolved ${busy}`, async () => {
      const h = setup();
      if (busy === 'attempt') h.state.attempts.push({ project: 'a', daemonId: 'daemon' });
      else if (busy === 'status') h.state.profiles[0]!.status = 'DEPLOYING';
      else h.state.references.push({ versionId: 1, buildId: 'a'.repeat(40), holderKind: busy, holderId: busy === 'job' ? 'a' : 'unknown-operation', services: ['srs'] });
      await assert.rejects(h.exporter.export('localhost'), /unresolved|in progress/);
    });
  }

  it('refuses a different observation daemon or database changes during capture', async () => {
    const wrong = setup();
    wrong.snapshot.daemonId = 'other';
    await assert.rejects(wrong.exporter.export('localhost'), /daemon/);
    const changed = setup();
    changed.change();
    await assert.rejects(changed.exporter.export('localhost'), /changed/);
  });
});
