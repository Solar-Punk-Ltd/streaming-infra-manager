import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../config.js';
import { discoverStamp, makeHost, waitForIdle } from '../harness/host.js';
import { startPublisher, type Publisher } from '../harness/publisher.js';
import { discoverCatalogFeed, fetchCatalog, type CatalogFeed } from '../harness/viewer.js';
import { sleep, waitFor } from '../harness/wait.js';

/**
 * Scenario E — SRS media-engine restart mid-stream; the broadcaster must be able to resume.
 *
 * REQUIRES the PR #10 recovery fix deployed: StreamOrchestrator.startStream now finalizes a stale
 * re-announced session and starts a fresh one, instead of rejecting it. Against an uploader WITHOUT
 * the fix the reconnect is rejected ("already active" → SRS_REJECT) and no new stream ever appears,
 * so this test times out — that is the pre-fix behaviour, not a flake.
 *
 * Restarting SRS drops ffmpeg's SRT (no auto-reconnect) so the first publisher dies. When a new
 * broadcaster session connects, SRS re-announces on_publish; the uploader finalizes the stale
 * session as a VOD and starts a fresh live stream — a new, distinct catalog entry via the gateway.
 */

const SRS_REBOOT_MS = 10_000;
const WARMUP_WAIT_MS = 90_000;
const RESUME_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

describe('E — SRS engine restart: broadcaster resumes', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const srs = containerName(cfg, 'srs');
  let first: Publisher;
  let second: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;

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
    first = startPublisher(cfg);
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
    await host.start(srs).catch(() => undefined);
  });

  it('starts a fresh live stream when the broadcaster reconnects after an engine restart', async () => {
    let firstTopic: string | undefined;
    await waitFor(
      async () => {
        const topics = await freshLiveTopics();
        if (topics.length >= 1) firstTopic = topics[0];
        return firstTopic !== undefined;
      },
      { timeoutMs: WARMUP_WAIT_MS, intervalMs: 3_000, label: 'first stream goes live before the engine restart' },
    );

    await host.restart(srs);
    await first.stop();
    await sleep(SRS_REBOOT_MS); // let SRS accept SRT again before the broadcaster reconnects

    second = startPublisher(cfg);

    let resumedTopic: string | undefined;
    await waitFor(
      async () => {
        const topics = (await freshLiveTopics()).filter((t) => t !== firstTopic);
        if (topics.length >= 1) resumedTopic = topics[0];
        return resumedTopic !== undefined;
      },
      { timeoutMs: RESUME_WAIT_MS, intervalMs: 3_000, label: 'a fresh live stream appears after the broadcaster reconnects' },
    );

    assert.ok(
      resumedTopic && resumedTopic !== firstTopic,
      'reconnecting after an SRS restart must yield a new live stream, not a rejection',
    );
  });
});
