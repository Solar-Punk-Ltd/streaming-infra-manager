import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { engineOverviewIdentity, type EngineOverview, type EngineOverviewIdentity, type StackContract } from '@streaming-infra-manager/common';
import type { Profile } from '../../src/types/index.js';
import { OME_TEMPLATE } from '../support/omeTemplate.js';

const root = mkdtempSync(join(tmpdir(), 't11-overview-snapshot-'));
const previousRoot = process.env.SHLS_ROOT;
process.env.SHLS_ROOT = root;
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/t11_unused';
mkdirSync(join(root, 'engines', 'ome'), { recursive: true });
writeFileSync(join(root, 'engines', 'ome', 'Server.xml.template'), OME_TEMPLATE);
writeFileSync(join(root, '.env'), 'HLS_SEGMENT_DURATION=6\n');

const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { EventBus } = await import('../../src/domain/EventBus.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');

type Harness = ReturnType<typeof profileServiceHarness>;
type IdentifiedOverview = EngineOverview & { identity: EngineOverviewIdentity };
const literal = (value: string, template = OME_TEMPLATE) => template.replaceAll('SEGMENT_DURATION_PLACEHOLDER', value)
  .replaceAll('SEGMENT_COUNT_PLACEHOLDER', '8');
const observedProfile = (patch: Partial<Profile> = {}) => profileRow({
  kind: 'custom', components: ['ome', 'stream-uploader'], has_engine_config: true,
  engine_config_revision: 3, intent_revision: 4,
  engine_settings: { HLS_SEGMENT_DURATION: '7', OME_HLS_POLL_INTERVAL_MS: '750' }, ...patch,
});

after(() => {
  if (previousRoot === undefined) delete process.env.SHLS_ROOT;
  else process.env.SHLS_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

async function appFor(profile: Profile = observedProfile(), config = literal('4')) {
  const harness = profileServiceHarness([profile]);
  harness.profiles.engineConfigs.set(profile.name, config);
  const app = await startEngineTestApp(harness.service, new ContainerControl(new EventBus(), fakeDocker([])));
  return { harness, app };
}

function holdFirstVersionRead(harness: Harness) {
  const find = harness.versions.findById.bind(harness.versions);
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  harness.versions.findById = async id => {
    const captured = structuredClone(await find(id));
    reads += 1;
    if (reads === 1) { entered(); await resume; }
    return captured;
  };
  return {
    release, reads: () => reads,
    async wait() {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([arrived, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Version read did not arrive.')), 2000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

describe('engine overview identity through the real HTTP route', { timeout: 15000 }, () => {
  it('keeps the captured config and identity together while a config edit commits', async () => {
    const initial = observedProfile();
    const { harness, app } = await appFor(initial);
    const gate = holdFirstVersionRead(harness);
    const pending = callEngine(app, 'GET', '/profiles/stream1/engine');
    try {
      await gate.wait();
      const changed = observedProfile({ engine_config_revision: 4, intent_revision: 5 });
      harness.profiles.rows.set(initial.name, changed);
      harness.profiles.engineConfigs.set(initial.name, literal('5'));
      gate.release();
      const result = await pending;
      assert.equal(result.status, 200);
      const old = result.body as IdentifiedOverview;
      assert.equal(old.effective.HLS_SEGMENT_DURATION, '4');
      assert.deepEqual(old.identity, engineOverviewIdentity(initial));
      assert.equal(gate.reads(), 1);
      const current = (await callEngine(app, 'GET', '/profiles/stream1/engine')).body as IdentifiedOverview;
      assert.equal(current.effective.HLS_SEGMENT_DURATION, '5');
      assert.deepEqual(current.identity, engineOverviewIdentity(changed));
    } finally { gate.release(); await pending; await app.close(); }
  });

  it('cannot label a replacement config with the removed instance identity', async () => {
    const initial = observedProfile();
    const { harness, app } = await appFor(initial);
    const gate = holdFirstVersionRead(harness);
    const pending = callEngine(app, 'GET', '/profiles/stream1/engine');
    try {
      await gate.wait();
      const replacement = observedProfile({ instance_id: 'replacement-instance', engine_config_revision: 0, intent_revision: 0 });
      harness.profiles.rows.delete(initial.name);
      harness.profiles.engineConfigs.delete(initial.name);
      harness.profiles.rows.set(initial.name, replacement);
      harness.profiles.engineConfigs.set(initial.name, literal('5'));
      gate.release();
      const old = (await pending).body as IdentifiedOverview;
      assert.equal(old.effective.HLS_SEGMENT_DURATION, '4');
      assert.deepEqual(old.identity, engineOverviewIdentity(initial));
      const current = (await callEngine(app, 'GET', '/profiles/stream1/engine')).body as IdentifiedOverview;
      assert.deepEqual(current.identity, engineOverviewIdentity(replacement));
      assert.equal(current.effective.HLS_SEGMENT_DURATION, '5');
    } finally { gate.release(); await pending; await app.close(); }
  });

  it('identifies changed settings even when both timestamps are the same millisecond', async () => {
    const initial = observedProfile({ has_engine_config: false });
    const { harness, app } = await appFor(initial);
    const gate = holdFirstVersionRead(harness);
    const pending = callEngine(app, 'GET', '/profiles/stream1/engine');
    try {
      await gate.wait();
      const changed = observedProfile({ has_engine_config: false, engine_settings: { HLS_SEGMENT_DURATION: '9' } });
      harness.profiles.rows.set(initial.name, changed);
      gate.release();
      const old = (await pending).body as IdentifiedOverview;
      assert.equal(old.effective.HLS_SEGMENT_DURATION, '7');
      assert.deepEqual(old.identity, engineOverviewIdentity(initial));
      const current = (await callEngine(app, 'GET', '/profiles/stream1/engine')).body as IdentifiedOverview;
      assert.equal(current.effective.HLS_SEGMENT_DURATION, '9');
      assert.deepEqual(current.identity, engineOverviewIdentity(changed));
      assert.notEqual(old.identity.settingsKey, current.identity.settingsKey);
    } finally { gate.release(); await pending; await app.close(); }
  });

  it('uses one captured version for defaults and live-status explanation', async () => {
    const { harness, app } = await appFor(profileRow());
    const contract: StackContract = {
      ports: [], maxSlot: 99, requiredSecrets: [], engineDefaults: { HLS_WINDOW: '12' },
      features: { srsApiPort: false, chequebookGate: true }, chequebookMinBzz: '0.5',
      engineConfig: { srs: true, ome: true }, engineImages: { srs: null, ome: null }, warnings: [],
    };
    await harness.versions.setContract(1, contract);
    const gate = holdFirstVersionRead(harness);
    const pending = callEngine(app, 'GET', '/profiles/stream1/engine');
    try {
      await gate.wait();
      await harness.versions.setContract(1, { ...contract, engineDefaults: { HLS_WINDOW: '15' },
        features: { ...contract.features, srsApiPort: true } });
      gate.release();
      const old = (await pending).body as IdentifiedOverview;
      assert.equal(old.effective.HLS_WINDOW, '12');
      assert.match(old.liveUnavailableReason, /does not publish/);
      assert.equal(gate.reads(), 1);
      const current = (await callEngine(app, 'GET', '/profiles/stream1/engine')).body as IdentifiedOverview;
      assert.equal(current.effective.HLS_WINDOW, '15');
      assert.match(current.liveUnavailableReason, /publishes the SRS API port/);
    } finally { gate.release(); await pending; await app.close(); }
  });

  it('reads host values and config paths from that same selected version root', async () => {
    const selectedRoot = join(root, 'selected');
    const template = OME_TEMPLATE.replaceAll('<HLS>', '<LLHLS>').replaceAll('</HLS>', '</LLHLS>');
    mkdirSync(join(selectedRoot, 'engines', 'ome'), { recursive: true });
    writeFileSync(join(selectedRoot, 'engines', 'ome', 'Server.xml.template'), template);
    writeFileSync(join(selectedRoot, '.env'), 'OME_HLS_POLL_INTERVAL_MS=900\n');
    const profile = observedProfile({ stack_version_id: 2, engine_settings: {} });
    const { harness, app } = await appFor(profile, literal('4', template));
    await harness.versions.insert({ name: 'selected', gitRef: 'fixture', rootPath: selectedRoot });
    try {
      const result = await callEngine(app, 'GET', '/profiles/stream1/engine');
      assert.equal(result.status, 200);
      const overview = result.body as IdentifiedOverview;
      assert.equal(overview.effective.HLS_SEGMENT_DURATION, '4');
      assert.equal(overview.effective.OME_HLS_POLL_INTERVAL_MS, '900');
      assert.deepEqual(overview.identity, engineOverviewIdentity(profile));
    } finally { await app.close(); }
  });

  it('does not invent fallback evidence when the selected version is absent', async () => {
    const { harness, app } = await appFor();
    await harness.versions.remove(1);
    try {
      const result = await callEngine(app, 'GET', '/profiles/stream1/engine');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'stack_version_not_found', id: 1 });
    } finally { await app.close(); }
  });

  it('keeps a missing deployment and a deployment without an engine distinct', async () => {
    const { app } = await appFor(profileRow({ kind: 'custom', components: ['bee-uploader'] }));
    try {
      assert.equal((await callEngine(app, 'GET', '/profiles/missing/engine')).status, 404);
      assert.equal((await callEngine(app, 'GET', '/profiles/stream1/engine')).status, 400);
    } finally { await app.close(); }
  });

  it('returns only identified scalar observations and never the stored config', async () => {
    const profile = observedProfile();
    const { app } = await appFor(profile, literal('4') + '<!-- synthetic-private-config-marker -->');
    try {
      const result = await callEngine(app, 'GET', '/profiles/stream1/engine');
      assert.equal(result.status, 200);
      assert.doesNotMatch(JSON.stringify(result.body), /synthetic-private-config-marker|engine_config/);
      assert.deepEqual((result.body as IdentifiedOverview).identity, engineOverviewIdentity(profile));
    } finally { await app.close(); }
  });
});
