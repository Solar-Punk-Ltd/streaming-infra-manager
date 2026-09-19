import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HostCollector } from '../../src/domain/HostCollector.js';

function netDev(rxBytes: number, txBytes: number): string {
  return `eth0: ${rxBytes} 0 0 0 0 0 0 0 ${txBytes} 0 0 0 0 0 0 0\n`;
}

async function makeProcFixture(caller: string, host?: string) {
  const procPath = await mkdtemp(join(tmpdir(), 'host-collector-proc-'));
  await mkdir(join(procPath, 'net'), { recursive: true });
  await writeFile(join(procPath, 'net/dev'), caller);

  const hostNetPath = join(procPath, '1/net/dev');
  if (host !== undefined) {
    await mkdir(join(procPath, '1/net'), { recursive: true });
    await writeFile(hostNetPath, host);
  }

  return {
    hostNetPath,
    procPath,
    removeHost: () => rm(join(procPath, '1'), { recursive: true, force: true }),
    restoreHost: async (contents: string) => {
      await mkdir(join(procPath, '1/net'), { recursive: true });
      await writeFile(hostNetPath, contents);
    },
    cleanUp: () => rm(procPath, { recursive: true, force: true }),
  };
}

describe('HostCollector network readings', () => {
  it('reads the host init process network view instead of the caller view', async () => {
    const fixture = await makeProcFixture(netDev(900, 1_000), netDev(100, 200));
    try {
      const sample = await new HostCollector(fixture.procPath, fixture.procPath).sample();

      assert.equal(sample.netRxBytes, 100);
      assert.equal(sample.netTxBytes, 200);
    } finally {
      await fixture.cleanUp();
    }
  });

  it('returns null when the host network view is unavailable even if the caller view exists', async () => {
    const fixture = await makeProcFixture(netDev(900, 1_000));
    try {
      const sample = await new HostCollector(fixture.procPath, fixture.procPath).sample();

      assert.equal(sample.netRxBytes, null);
      assert.equal(sample.netTxBytes, null);
      assert.equal(sample.netRxRate, null);
      assert.equal(sample.netTxRate, null);
    } finally {
      await fixture.cleanUp();
    }
  });

  it('starts a fresh rate baseline after the host network view returns', async (t) => {
    const fixture = await makeProcFixture(netDev(900, 1_000), netDev(100, 200));
    let now = 1_000;
    t.mock.method(Date, 'now', () => now);

    try {
      const collector = new HostCollector(fixture.procPath, fixture.procPath);
      await collector.sample();

      await fixture.removeHost();
      now = 2_000;
      assert.equal((await collector.sample()).netRxBytes, null);

      await fixture.restoreHost(netDev(300, 500));
      now = 3_000;
      const restored = await collector.sample();

      assert.equal(restored.netRxBytes, 300);
      assert.equal(restored.netTxBytes, 500);
      assert.equal(restored.netRxRate, 0);
      assert.equal(restored.netTxRate, 0);
    } finally {
      await fixture.cleanUp();
    }
  });
});
