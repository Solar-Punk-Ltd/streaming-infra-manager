import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { EngineOverview } from '@streaming-infra-manager/common';

const root = mkdtempSync(join(tmpdir(), 't11-srs-overview-'));
const previousRoot = process.env.SHLS_ROOT;
process.env.SHLS_ROOT = root;
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/t11_unused';
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'),
  'vhost __defaultVhost__ { hls { hls_fragment HLS_FRAGMENT_PLACEHOLDER; hls_window HLS_WINDOW_PLACEHOLDER; }\nTRANSCODE_PLACEHOLDER\n}\nABR_VHOST_PLACEHOLDER\n');
writeFileSync(join(root, '.env'), 'ENGINE=srs\nHLS_FRAGMENT=0.5\nHLS_WINDOW=15\n');

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

async function overviewFor(config: string, abr = true): Promise<EngineOverview> {
  const harness = profileServiceHarness([profileRow({
    kind: abr ? 'abr-uploader' : 'streamer',
    bee_publishers: abr ? `1080p@http://127.0.0.1:1<${'a'.repeat(64)}>` : null,
    has_engine_config: true, engine_settings: { HLS_FRAGMENT: '7', HLS_WINDOW: '45', ABR_FPS: '30' },
  })]);
  harness.profiles.engineConfigs.set('stream1', config);
  const app = await startEngineTestApp(harness.service, new ContainerControl(new EventBus(), fakeDocker([])));
  try {
    const response = await callEngine(app, 'GET', '/profiles/stream1/engine');
    assert.equal(response.status, 200);
    assert.equal((response.body as EngineOverview).engine, 'srs');
    return response.body as EngineOverview;
  } finally {
    await app.close();
  }
}

const literal = 'vhost main { hls { hls_fragment 4; hls_window 30; } transcode { engine low { vfps 25; vpreset fast; vprofile main; vthreads 2; acodec aac; abitrate 128; } } }';

describe('SRS settings observations over the actual engine HTTP route', () => {
  it('shows reliable custom-file literals over stored and host values', async () => {
    const overview = await overviewFor(literal);
    assert.equal(overview.effective.HLS_FRAGMENT, '4');
    assert.equal(overview.effective.HLS_WINDOW, '30');
    assert.equal(overview.effective.ABR_FPS, '25');
    assert.equal(overview.effective.ABR_AUDIO_BITRATE, '128');
    assert.equal(overview.observations.HLS_FRAGMENT.source, 'config-file');
    assert.equal(overview.observations.ABR_FPS.source, 'config-file');
    assert.equal(overview.effective.ABR_VBV_SECONDS, undefined);
  });

  it('a generated HLS vhost leaves explicit encoder observations independently known', async () => {
    const overview = await overviewFor(`${literal}\nABR_VHOST_PLACEHOLDER\n`);
    assert.equal(overview.effective.HLS_FRAGMENT, undefined);
    assert.equal(overview.observations.HLS_FRAGMENT.status, 'unknown');
    assert.equal(overview.effective.ABR_FPS, '25');
    assert.equal(overview.effective.ABR_AUDIO_BITRATE, '128');
  });

  it('an HLS include does not hide explicit encoder fields or follow a file path', async () => {
    const overview = await overviewFor(literal.replace('hls_window 30;', 'hls_window 30; include unavailable.conf;'));
    assert.equal(overview.effective.HLS_WINDOW, undefined);
    assert.equal(overview.effective.ABR_FPS, '25');
  });

  it('excludes ABR observations for a non-ladder deployment', async () => {
    const overview = await overviewFor(literal, false);
    assert.deepEqual(overview.effective, { HLS_FRAGMENT: '4', HLS_WINDOW: '30' });
    assert.equal(overview.observations.ABR_FPS, undefined);
  });

  it('does not expose effective values from unmodeled generation-marker placement', async () => {
    const overview = await overviewFor(`# ABR_VHOST_PLACEHOLDER\n${literal}`);
    assert.deepEqual(overview.effective, {});
  });

  it('does not expose literals when generated blocks would be inserted in an unsupported scope', async () => {
    for (const file of [
      literal.replace('hls_window 30;', 'hls_window 30;\nTRANSCODE_PLACEHOLDER\n'),
      literal.replace('transcode {', '\nABR_VHOST_PLACEHOLDER\ntranscode {'),
    ]) {
      assert.deepEqual((await overviewFor(file)).effective, {});
      assert.deepEqual((await overviewFor(file, false)).effective, { HLS_FRAGMENT: '4', HLS_WINDOW: '30' });
    }
  });

  it('keeps a later same-line HLS placeholder unverified while preserving explicit encoder values', async () => {
    const file = literal.replace('hls_fragment 4;', 'hls_fragment HLS_FRAGMENT_PLACEHOLDER;')
      + ' vhost extra { hls { hls_fragment HLS_FRAGMENT_PLACEHOLDER; hls_window 30; } }';
    const overview = await overviewFor(file);
    assert.equal(overview.effective.HLS_FRAGMENT, undefined);
    assert.equal(overview.effective.HLS_WINDOW, '30');
    assert.equal(overview.effective.ABR_FPS, '25');
  });
});
