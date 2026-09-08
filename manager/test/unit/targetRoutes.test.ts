import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createTargetsRouter } from '../../src/api/routes/targets.js';
import { VerifiedDeployTargets } from '../../src/domain/ports/VerifiedDeployTargets.js';
import { InMemoryDeployTargets } from '../support/InMemoryDeployTargets.js';
import { InMemoryPortReservations } from '../support/InMemoryPortReservations.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';
import { InvalidStackVersionError } from '../../src/domain/errors/index.js';

describe('deploy targets API', () => {
  let app: RouterTestApp;
  afterEach(async () => app?.close());

  it('exports the requested firewall inventory without running inventory recovery', async () => {
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => { throw new Error('unexpected probe'); } });
    const aliases: string[] = [];
    const evidence = { schemaVersion: 1 as const, policyVersion: 1, daemonId: 'remote', capturedAt: '2026-09-08T00:00:00Z',
      fingerprint: 'a'.repeat(64), profiles: [], claims: [], reservations: [], bindings: [] };
    const inventory = { seed: async () => { throw new Error('must not seed'); }, daemonIdFor: async () => { throw new Error('must not seed'); } };
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations(), inventory,
      { export: async alias => { aliases.push(alias); return evidence; } }), '/targets');
    const response = await call(app, 'GET', '/targets/firewall?alias=admin%40edge');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, evidence);
    assert.deepEqual(aliases, ['admin@edge']);
    for (const query of ['', '?alias=', '?alias=a&alias=b']) {
      assert.equal((await call(app, 'GET', '/targets/firewall' + query)).status, 400);
    }
    assert.equal(aliases.length, 1);
  });

  it('reports unconfigured firewall export without probing', async () => {
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => 'daemon-1' });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations()), '/targets');
    assert.equal((await call(app, 'GET', '/targets/firewall?alias=localhost')).status, 503);
  });

  it('returns a refusal instead of partial firewall evidence', async () => {
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => 'daemon-1' });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations(), undefined,
      { export: async () => { throw new InvalidStackVersionError('Firewall inventory: unknown binding'); } }), '/targets');
    const response = await call(app, 'GET', '/targets/firewall?alias=localhost');
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body), /unknown binding/);
    assert.doesNotMatch(JSON.stringify(response.body), /claims|fingerprint/);
  });

  it('retries an incomplete boot inventory through the API', async () => {
    const ports = new InMemoryPortReservations();
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => 'daemon-1' });
    let fails = true;
    const inventory = { seed: async () => {
      if (fails) throw new Error('scan unavailable');
      await ports.markInventorySeeded();
    }, daemonIdFor: async () => 'daemon-1' };
    app = await startRouterTestApp(createTargetsRouter(targets, ports, inventory), '/targets');
    assert.equal((await call(app, 'POST', '/targets/inventory', {})).status, 500);
    assert.equal(await ports.inventorySeededAt(), null);
    fails = false;
    assert.equal((await call(app, 'POST', '/targets/inventory', {})).status, 200);
    assert.ok(await ports.inventorySeededAt());
  });

  it('verification also scans the target inventory and retries incomplete boot seeding', async () => {
    const ports = new InMemoryPortReservations();
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => 'remote' });
    const calls: string[] = [];
    const inventory = { seed: async () => { calls.push('seed'); }, daemonIdFor: async (alias: string | null) => {
      calls.push(alias!);
      await ports.markInventorySeeded('remote');
      return 'remote';
    } };
    app = await startRouterTestApp(createTargetsRouter(targets, ports, inventory), '/targets');
    assert.equal((await call(app, 'POST', '/targets/verify', { alias: 'edge' })).status, 200);
    assert.deepEqual(calls, ['edge', 'seed']);
    const listed = await call(app, 'GET', '/targets');
    assert.ok((listed.body as { targets: { inventorySeededAt: string | null }[] }).targets[0]!.inventorySeededAt);
  });

  it('lists the mapping and inventory state without performing a probe', async () => {
    const repo = new InMemoryDeployTargets();
    await repo.verified('edge', 'daemon-1');
    const targets = new VerifiedDeployTargets(repo, { daemonId: async () => { throw new Error('must not probe on GET'); } });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations()), '/targets');

    const response = await call(app, 'GET', '/targets');
    assert.equal(response.status, 200);
    const body = response.body as { targets: { alias: string; daemonId: string; verifiedAt: string }[]; inventorySeededAt: string | null };
    assert.equal(body.inventorySeededAt, null);
    assert.equal(body.targets[0]!.alias, 'edge');
    assert.equal(body.targets[0]!.daemonId, 'daemon-1');
    assert.ok(Number.isFinite(Date.parse(body.targets[0]!.verifiedAt)));
  });

  it('verifies the requested alias on demand and returns its stored mapping', async () => {
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => 'daemon-1' });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations()), '/targets');
    const response = await call(app, 'POST', '/targets/verify', { alias: 'edge' });
    assert.equal(response.status, 200);
    assert.equal((response.body as { target: { daemonId: string } }).target.daemonId, 'daemon-1');
  });

  it('reports a failed check as a refusal, and the following list shows it unverified', async () => {
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => { throw new Error('raw diagnostic'); } });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations()), '/targets');
    const response = await call(app, 'POST', '/targets/verify', { alias: 'edge' });
    assert.equal(response.status, 409);
    assert.doesNotMatch(JSON.stringify(response.body), /raw diagnostic/);
    const listed = await call(app, 'GET', '/targets');
    assert.equal((listed.body as { targets: { verifiedAt: null }[] }).targets[0]!.verifiedAt, null);
  });

  it('rejects an absent or non-string alias without probing', async () => {
    let probes = 0;
    const targets = new VerifiedDeployTargets(new InMemoryDeployTargets(), { daemonId: async () => { probes += 1; return 'daemon-1'; } });
    app = await startRouterTestApp(createTargetsRouter(targets, new InMemoryPortReservations()), '/targets');
    for (const body of [{}, { alias: 7 }, { alias: '' }]) {
      assert.equal((await call(app, 'POST', '/targets/verify', body)).status, 400);
    }
    assert.equal(probes, 0);
  });
});
