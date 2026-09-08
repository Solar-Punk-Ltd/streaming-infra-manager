import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { EngineOverview } from '@streaming-infra-manager/common';
import { OME_TEMPLATE } from '../support/omeTemplate.js';

const root = mkdtempSync(join(tmpdir(), 't11-ome-overview-'));
const previousRoot = process.env.SHLS_ROOT;
process.env.SHLS_ROOT = root;
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/t11_unused';
mkdirSync(join(root, 'engines', 'ome'), { recursive: true });
writeFileSync(join(root, 'engines', 'ome', 'Server.xml.template'), OME_TEMPLATE);
writeFileSync(join(root, '.env'), 'ENGINE=ome\nHLS_SEGMENT_DURATION=6\nHLS_SEGMENT_COUNT=9\n');

const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { EventBus } = await import('../../src/domain/EventBus.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');

after(() => {
  if (previousRoot === undefined) delete process.env.SHLS_ROOT;
  else process.env.SHLS_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

async function overviewFor(config: string | null, template = OME_TEMPLATE): Promise<EngineOverview> {
  writeFileSync(join(root, 'engines', 'ome', 'Server.xml.template'), template);
  const harness = profileServiceHarness([profileRow({
    kind: 'custom', components: ['ome', 'bee-uploader', 'stream-uploader'], has_engine_config: true,
    engine_settings: { HLS_SEGMENT_DURATION: '7', HLS_SEGMENT_COUNT: '11', OME_HLS_POLL_INTERVAL_MS: '750' },
  })]);
  if (config !== null) harness.profiles.engineConfigs.set('stream1', config);
  const app = await startEngineTestApp(harness.service, new ContainerControl(new EventBus(), fakeDocker([])));
  try {
    const response = await callEngine(app, 'GET', '/profiles/stream1/engine');
    assert.equal(response.status, 200);
    assert.equal((response.body as EngineOverview).engine, 'ome');
    return response.body as EngineOverview;
  } finally {
    await app.close();
  }
}

const literal = () => OME_TEMPLATE.replaceAll('SEGMENT_DURATION_PLACEHOLDER', '4').replaceAll('SEGMENT_COUNT_PLACEHOLDER', '8');
const duration = '<SegmentDuration>SEGMENT_DURATION_PLACEHOLDER</SegmentDuration>';

describe('OME overview observations through the real HTTP route', () => {
  it('reads matching literals at both template-derived HLS paths over conflicting stored and host values', async () => {
    const overview = await overviewFor(literal());
    assert.deepEqual(overview.effective, { HLS_SEGMENT_DURATION: '4', HLS_SEGMENT_COUNT: '8', OME_HLS_POLL_INTERVAL_MS: '750' });
    assert.deepEqual(overview.observations.HLS_SEGMENT_DURATION, { status: 'known', source: 'config-file', value: '4', environment: 'none' });
    assert.equal(overview.observations.HLS_SEGMENT_COUNT.source, 'config-file');
    assert.deepEqual(overview.notInConfig, ['HLS_SEGMENT_DURATION', 'HLS_SEGMENT_COUNT']);
  });

  it('keeps environment readings and sources when every mapped setting is still a placeholder', async () => {
    const overview = await overviewFor(OME_TEMPLATE);
    assert.equal(overview.effective.HLS_SEGMENT_DURATION, '7');
    assert.equal(overview.observations.HLS_SEGMENT_DURATION.source, 'deployment');
    assert.equal(overview.observations.HLS_SEGMENT_DURATION.environment, 'all');
    assert.deepEqual(overview.notInConfig, []);
  });

  it('reports a mapped directive missing from one application instead of using the other occurrence', async () => {
    const overview = await overviewFor(OME_TEMPLATE.replace(duration, ''));
    assert.equal(overview.effective.HLS_SEGMENT_DURATION, undefined);
    assert.deepEqual(overview.observations.HLS_SEGMENT_DURATION, { status: 'unknown', source: 'omitted', value: null, reason: 'missing-directive', environment: 'partial' });
    assert.equal(overview.effective.HLS_SEGMENT_COUNT, '11');
  });

  it('leaves differing values and mixed sources unverified per field', async () => {
    const conflicting = await overviewFor(literal().replace('<SegmentDuration>4</SegmentDuration>', '<SegmentDuration>5</SegmentDuration>'));
    assert.equal(conflicting.effective.HLS_SEGMENT_DURATION, undefined);
    assert.equal(conflicting.observations.HLS_SEGMENT_DURATION.status === 'unknown' && conflicting.observations.HLS_SEGMENT_DURATION.reason, 'conflicting-values');
    const mixed = await overviewFor(OME_TEMPLATE.replace(duration, '<SegmentDuration>7</SegmentDuration>'));
    assert.equal(mixed.effective.HLS_SEGMENT_DURATION, undefined);
    assert.equal(mixed.observations.HLS_SEGMENT_DURATION.status === 'unknown' && mixed.observations.HLS_SEGMENT_DURATION.reason, 'mixed-sources');
  });

  it('treats a duplicate path as ambiguous without hiding an unrelated setting', async () => {
    const overview = await overviewFor(OME_TEMPLATE.replace(duration, duration + duration));
    assert.equal(overview.effective.HLS_SEGMENT_DURATION, undefined);
    assert.equal(overview.observations.HLS_SEGMENT_DURATION.status === 'unknown' && overview.observations.HLS_SEGMENT_DURATION.reason, 'ambiguous-path');
    assert.equal(overview.effective.HLS_SEGMENT_COUNT, '11');
  });

  it('ignores tokens in comments and unrelated branches when observing literal HLS values', async () => {
    const file = literal().replace('</Server>', '<!-- SEGMENT_DURATION_PLACEHOLDER --><Unrelated>SEGMENT_DURATION_PLACEHOLDER</Unrelated></Server>');
    assert.equal((await overviewFor(file)).effective.HLS_SEGMENT_DURATION, '4');
  });

  it('preserves the independent uploader750 reading when XML, config or template is unavailable', async () => {
    for (const [config, template] of [['<Server><broken></Server>', OME_TEMPLATE], [null, OME_TEMPLATE], [literal(), '<Server>']] as const) {
      const overview = await overviewFor(config, template);
      assert.deepEqual(overview.effective, { OME_HLS_POLL_INTERVAL_MS: '750' });
      assert.equal(overview.observations.HLS_SEGMENT_DURATION.status, 'unknown');
      assert.deepEqual(overview.observations.OME_HLS_POLL_INTERVAL_MS, { status: 'known', source: 'deployment', value: '750', environment: 'all' });
    }
  });

  it('rejects nested or invalid scalar content and repeated application identity', async () => {
    for (const file of [OME_TEMPLATE.replace(duration, '<SegmentDuration>4<Nested/></SegmentDuration>'),
      OME_TEMPLATE.replaceAll('SEGMENT_DURATION_PLACEHOLDER', 'invalid'),
      OME_TEMPLATE.replace('<Name>audio</Name>', '<Name>video</Name>')]) {
      const overview = await overviewFor(file);
      assert.equal(overview.effective.HLS_SEGMENT_DURATION, undefined);
      assert.equal(overview.observations.HLS_SEGMENT_DURATION.status, 'unknown');
      assert.equal(overview.effective.OME_HLS_POLL_INTERVAL_MS, '750');
    }
  });
});
