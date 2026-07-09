import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../config.js';
import { srtIngestUrl } from '../harness/engine.js';
import { discoverStamp, makeHost, uploaderHealth } from '../harness/host.js';

const ONE_HOUR_S = 3600;

/**
 * Read-only smoke test: proves the harness can reach the deployed profile and discover its live
 * stamp. No fault injection, no deploy, no BZZ — safe to run anytime. Run: pnpm test:e2e:smoke
 */
describe('attach smoke (read-only)', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);

  it('reaches the host over ssh', async () => {
    const { stdout } = await host.run('echo e2e-ok');
    assert.equal(stdout.trim(), 'e2e-ok');
  });

  it('finds the stream-uploader healthy', async () => {
    const health = await uploaderHealth(host, cfg);
    assert.equal(health.status, 'ok');
    assert.ok(Array.isArray(health.engines), 'engines should be a list');
    console.log(`  uploader: ${JSON.stringify(health)}`);
  });

  it('discovers a usable stamp with TTL headroom', async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.equal(stamp.usable, true);
    assert.ok(
      stamp.batchTTL > ONE_HOUR_S,
      `stamp TTL ${stamp.batchTTL}s is under 1h — top up before running a stream test`,
    );
    console.log(
      `  stamp ${stamp.batchID.slice(0, 12)}… TTL ${(stamp.batchTTL / ONE_HOUR_S).toFixed(1)}h util ${stamp.utilization}`,
    );
  });

  it('resolves the uploader container + prints the ingest URL', async () => {
    const container = containerName(cfg, 'stream-uploader');
    assert.ok(await host.isRunning(container), `${container} should be running`);
    console.log(`  ingest: ${srtIngestUrl(cfg)}`);
  });
});
