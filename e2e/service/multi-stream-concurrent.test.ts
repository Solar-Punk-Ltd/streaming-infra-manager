import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../harness/host.js';
import { parseUploaderLog } from '../harness/logwatch.js';
import { startPublisher, type Publisher } from '../harness/publisher.js';
import { discoverCatalogFeed, fetchCatalog, type CatalogFeed } from '../harness/viewer.js';
import { waitFor } from '../harness/wait.js';

/**
 * Service — two concurrent live streams upload independently. The uploader must track both in
 * activeStreams, give each its own catalog entry (distinct topic), and finalize each to its own VOD
 * — no cross-talk, no spurious discontinuity from the concurrency. Per-stream segments can't be
 * split from the logs (the "Segment N uploaded" line has no stream id), so streams are told apart by
 * their distinct catalog entries and counted via /health.
 */

const SECOND_STREAM_PATH = 'live/stream2';
const ACTIVE_WAIT_MS = 120_000;
const IDLE_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

describe('service — two concurrent streams upload independently', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let first: Publisher;
  let second: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;
  let startedAt: string;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return [];
    }
  };
  const freshLiveTopics = async (): Promise<string[]> => [
    ...new Set((await safeFetch()).filter((e) => !baselineTopics.has(e.topic) && e.state === 'live').map((e) => e.topic)),
  ];

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    baselineTopics = new Set((await safeFetch()).map((e) => e.topic));
    startedAt = await host.nowIso();
    first = startPublisher(cfg);
    second = startPublisher(cfg, { streamPath: SECOND_STREAM_PATH });
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
  });

  it('runs both live at once, each with its own catalog entry, then finalizes both as VOD', async () => {
    await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams >= 2, {
      timeoutMs: ACTIVE_WAIT_MS,
      intervalMs: 3_000,
      label: 'both streams register as active (activeStreams >= 2)',
    });

    let ourTopics: string[] = [];
    await waitFor(
      async () => {
        ourTopics = await freshLiveTopics();
        return ourTopics.length >= 2;
      },
      { timeoutMs: ACTIVE_WAIT_MS, intervalMs: 3_000, label: 'two distinct live entries appear in the gateway catalog' },
    );
    assert.ok(ourTopics.length >= 2, `expected two distinct concurrent streams; got topics: ${ourTopics.join(',')}`);

    const duringConcurrency = parseUploaderLog(await host.logsSince(uploader, startedAt));
    assert.equal(
      duringConcurrency.discontinuitiesArmed.length,
      0,
      `concurrent streams (no fault) must not arm a discontinuity; armed: ${duringConcurrency.discontinuitiesArmed.join(',')}`,
    );

    await first.stop();
    await second.stop();

    await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams === 0, {
      timeoutMs: IDLE_WAIT_MS,
      intervalMs: 3_000,
      label: 'both streams finalize and activeStreams returns to 0',
    });

    const finalCatalog = await safeFetch();
    const mine = finalCatalog.filter((e) => ourTopics.includes(e.topic));
    assert.equal(mine.length, ourTopics.length, 'both concurrent streams must remain in the catalog');
    for (const entry of mine) {
      assert.equal(entry.state, 'vod', `stream ${entry.topic} must finalize as VOD`);
      assert.ok((entry.duration ?? 0) > 0, `stream ${entry.topic} VOD must carry a positive duration; got ${entry.duration}`);
    }
  });
});
