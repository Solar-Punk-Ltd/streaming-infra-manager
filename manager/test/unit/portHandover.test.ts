import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PortHandover } from '../../src/domain/ports/PortHandover.js';
import type { PublishedPortsSnapshot } from '../../src/domain/ports/PublishedPortsProbe.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import type { BuildDescriptor } from '../../src/domain/versions/buildLedger.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { FakeDaemon, InMemoryDeployAttempts } from '../support/InMemoryDeployAttempts.js';
import { InMemoryPortReservations } from '../support/InMemoryPortReservations.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { makeProfile } from '../support/profileFixtures.js';

async function setup() {
  const ports = new InMemoryPortReservations();
  const profile = makeProfile({ name: 'a', status: 'DEPLOYING', port_slot: 1 });
  const old = [
    { name: 'RTMP_PORT', protocol: 'tcp' as const, service: 'srs', defaultPort: 10000, slotBase: 10000 },
    { name: 'HTTP_PORT', protocol: 'tcp' as const, service: 'stream-uploader', defaultPort: 10001, slotBase: 10001 },
  ];
  const current = old.map(port => ({ ...port, slotBase: port.slotBase + 10000 }));
  await ports.plan('daemon-1', 'a', portPlanFor(old, 1), 'old build');
  await ports.setState(ports.rows.map(row => row.id), 'active');
  await ports.plan('daemon-1', 'a', portPlanFor(current, 1), 'new build');
  const versions = new InMemoryStackVersionRepository();
  const version = versions.seedBundled();
  version.contract = { ...structuredClone(ALLOCATION_CONTRACT), ports: current };
  const build: BuildDescriptor = { version, buildId: 'new', referenceId: 42, root: '/fake/build' };
  const attempts = new InMemoryDeployAttempts();
  const attempt = await attempts.open({ daemonId: 'daemon-1', project: 'a', target: 'localhost',
    jobId: 'new-job', kind: 'fixed', services: ['srs'], preJobContainerIds: ['engine-old', 'uploader-old'] });
  const daemon = new FakeDaemon();
  daemon.set('a', 'srs', ['engine-new']);
  daemon.set('a', 'stream-uploader', ['uploader-old']);
  const snapshot: PublishedPortsSnapshot = { daemonId: 'daemon-1', bindings: [
    { project: 'a', service: 'srs', protocol: 'tcp', port: 20010 },
    { project: 'a', service: 'stream-uploader', protocol: 'tcp', port: 10011 },
  ] };
  const handover = new PortHandover(ports, { publishedPorts: async () => snapshot }, daemon);
  return { ports, profile, attempt, daemon, snapshot, handover, build,
    reconcile: () => handover.reconcile(profile, build, attempt),
    held: async () => (await ports.listByProfile('a')).map(row => row.port).sort((a, b) => a - b),
  };
}

describe('observed per-service port handover', () => {
  for (const firstServices of [['srs', 'stream-uploader'], ['stream-uploader']]) {
    it(`retains a port transferred to an untouched uploader after ${firstServices.join(' + ')} replacement`, async () => {
      const h = await setup();
      const b = [
        { name: 'RTMP_PORT', protocol: 'tcp' as const, service: 'srs', defaultPort: 20000, slotBase: 20000 },
        { name: 'HTTP_PORT', protocol: 'tcp' as const, service: 'stream-uploader', defaultPort: 10000, slotBase: 10000 },
      ];
      h.build.version!.contract!.ports = b;
      await h.ports.plan('daemon-1', 'a', portPlanFor(b, 1), 'B');
      h.daemon.set('a', 'srs', [firstServices.includes('srs') ? 'engine-B' : 'engine-old']);
      h.daemon.set('a', 'stream-uploader', ['uploader-B']);
      h.snapshot.bindings = portPlanFor(b, 1).filter(port => firstServices.includes(port.service!)).map(port => ({ ...port, project: 'a' }));
      await h.handover.reconcile(h.profile, h.build, { ...h.attempt, services: firstServices });
      const c = b.map(port => port.service === 'stream-uploader' ? { ...port, slotBase: 30001 } : port);
      h.build.version!.contract!.ports = c;
      await h.ports.plan('daemon-1', 'a', portPlanFor(c, 1), 'C');
      h.daemon.set('a', 'srs', ['engine-C']);
      h.snapshot.bindings = [{ project: 'a', service: 'srs', protocol: 'tcp', port: 20010 }];
      const nextAttempt = { ...h.attempt, services: ['srs'], preJobContainerIds: ['engine-old', 'engine-B', 'uploader-B'] };
      await h.handover.reconcile(h.profile, h.build, nextAttempt);
      assert.ok((await h.held()).includes(10010), 'the untouched stopped B uploader still needs P');
      h.daemon.set('a', 'stream-uploader', ['uploader-C']);
      h.snapshot.bindings = portPlanFor(c, 1).map(port => ({ ...port, project: 'a' }));
      await h.handover.reconcile(h.profile, h.build, { ...nextAttempt, services: ['srs', 'stream-uploader'] });
      assert.ok(!(await h.held()).includes(10010), 'P can go once every former owner is replaced');
    });
  }

  it('releases only the replaced engine ports and retains both uploader plans', async () => {
    const h = await setup();
    await h.reconcile();
    assert.deepEqual(await h.held(), [10011, 20010, 20011]);
    assert.equal(h.ports.rows.find(row => row.port === 20010)!.state, 'active');
  });

  it('retains an old port still bound anywhere on the daemon', async () => {
    const h = await setup();
    h.snapshot.bindings = [...h.snapshot.bindings, { project: 'outside', service: 'web', protocol: 'tcp', port: 10010 }];
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
  });

  it('retains every plan when the new engine has not bound its expected port', async () => {
    const h = await setup();
    h.snapshot.bindings = [];
    await h.reconcile();
    assert.deepEqual(await h.held(), [10010, 10011, 20010, 20011]);
  });

  it('does not mistake another project binding the desired port for a successful handover', async () => {
    const h = await setup();
    h.snapshot.bindings = [{ project: 'outside', service: 'srs', protocol: 'tcp', port: 20010 }];
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
  });

  it('keeps old ports while an old container still exists, even if a new replica is present', async () => {
    const h = await setup();
    h.daemon.set('a', 'srs', ['engine-old', 'engine-new']);
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
  });

  it('does not release anything on a stopped profile', async () => {
    const h = await setup();
    h.profile.status = 'STOPPED';
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
  });

  it('retains plans while an unresolved job or rollback operation still needs them', async () => {
    const h = await setup();
    h.ports.releaseBlocked = () => true;
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
    h.ports.releaseBlocked = () => false;
    await h.reconcile();
    assert.ok(!(await h.held()).includes(10010));
  });

  for (const wrongSnapshot of ['ports', 'containers'] as const) {
    it(`retains plans when ${wrongSnapshot} came from a different daemon`, async () => {
      const h = await setup();
      if (wrongSnapshot === 'ports') h.snapshot.daemonId = 'other';
      else h.daemon.id = 'other';
      await assert.rejects(h.reconcile(), /different Docker daemon/);
      assert.ok((await h.held()).includes(10010));
    });
  }

  it('retains ports when a host-network container makes absence unprovable', async () => {
    const h = await setup();
    h.snapshot.unverifiedProjects = ['outside-host-network'];
    await h.reconcile();
    assert.ok((await h.held()).includes(10010));
  });
});
