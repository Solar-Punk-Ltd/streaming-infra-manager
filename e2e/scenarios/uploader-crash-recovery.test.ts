import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../harness/host.js';
import { parseUploaderLog } from '../harness/logwatch.js';
import { startPublisher, type Publisher } from '../harness/publisher.js';
import { discoverCatalogFeed, fetchCatalog, type CatalogFeed } from '../harness/viewer.js';
import { sleep, waitFor } from '../harness/wait.js';

/**
 * Scenario F — uploader hard crash mid-stream; the same live stream must recover AND keep running.
 *
 * REQUIRES the PR #10 recovery fix deployed: StreamOrchestrator.handleSegment now cancels the
 * recovery finalize timer when segments resume. WITHOUT the fix a hard-crash-recovered stream
 * resumes uploading but the 60s recovery timer still VODs it (SRS never re-sends on_publish), so
 * the final assertion fails — that is the pre-fix behaviour, not a flake.
 *
 * SIGKILL (docker kill) leaves the RecoveryStore state intact; the test then restarts the container
 * (docker kill does not trip the restart policy in this environment, so we stand in for it);
 * recoverStreams restores the stream + a 60s timer; SRS keeps POSTing segments (it was not
 * restarted, so seq_no keeps climbing) → handleSegment accepts them and cancels the timer.
 */

const RECOVERY_TIMEOUT_MS = 60_000; // mirrors the uploader RECOVERY_TIMEOUT default
const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const REBOOT_WAIT_MS = 60_000;
const RESUME_WAIT_MS = 120_000;
const POST_TIMEOUT_MARGIN_MS = 20_000;
const MIN_STAMP_TTL_S = 600;

describe('F — uploader hard crash: same stream recovers and keeps running', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
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
  const uploaded = async (): Promise<number[]> =>
    parseUploaderLog(await host.logsSince(uploader, startedAt)).uploadedSegments;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    baselineTopics = new Set((await safeFetch()).map((e) => e.topic));
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('resumes the recovered stream and does not VOD it at the recovery timeout', async () => {
    let ourTopic: string | undefined;
    await waitFor(
      async () => {
        const fresh = (await safeFetch()).filter((e) => !baselineTopics.has(e.topic) && e.state === 'live');
        if (fresh.length >= 1) ourTopic = fresh[0].topic;
        return (await uploaded()).length >= WARMUP_SEGMENTS && ourTopic !== undefined;
      },
      { timeoutMs: WARMUP_WAIT_MS, intervalMs: 3_000, label: 'stream is live and uploading before the crash' },
    );
    const preKill = Math.max(...(await uploaded()));

    // Hard crash: SIGKILL leaves the RecoveryStore state on disk. `docker kill` does not trip the
    // restart policy here, so bring the container back explicitly (standing in for the restart
    // policy / orchestrator rebooting a crashed process). The publisher keeps streaming throughout.
    await host.kill(uploader);
    await waitFor(async () => !(await host.isRunning(uploader)), {
      timeoutMs: 15_000,
      intervalMs: 1_000,
      label: 'uploader container fully stopped after the kill',
    });
    await host.start(uploader);
    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status === 'ok';
        } catch {
          return false;
        }
      },
      { timeoutMs: REBOOT_WAIT_MS, intervalMs: 2_000, label: 'uploader reboots after the hard crash' },
    );

    // Segments resume — SRS was not restarted, so its seq_no keeps climbing past the pre-crash max.
    await waitFor(
      async () => {
        const ups = await uploaded();
        return ups.length > 0 && Math.max(...ups) > preKill;
      },
      { timeoutMs: RESUME_WAIT_MS, intervalMs: 3_000, label: 'segments resume after recovery' },
    );

    // The recovery finalize timer must have been cancelled: the stream stays live past the timeout.
    await sleep(RECOVERY_TIMEOUT_MS + POST_TIMEOUT_MARGIN_MS);
    const entry = (await safeFetch()).find((e) => e.topic === ourTopic);
    assert.ok(entry, `the recovered stream ${ourTopic} must still be in the catalog`);
    assert.equal(entry?.state, 'live', 'the recovered stream must stay live, not be VOD-ed by the recovery timer');
  });
});
