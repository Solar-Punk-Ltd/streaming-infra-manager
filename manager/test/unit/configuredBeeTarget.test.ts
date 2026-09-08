import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfiguredBeeTargetResolver } from '../../src/domain/chequebook/ConfiguredBeeTargetResolver.js';
import type { Profile } from '../../src/types/index.js';

const profile = { name: 'deployment', port_slot: 1, host: 'bee-host', kind: 'streamer', components: null, status: 'RUNNING',
  created_at: new Date(0), updated_at: new Date(0), stack_version_id: 1 } as Profile;
const bee = { service: 'bee-uploader', ports: { BEE_UPLOADER_API_PORT: 12005 } };
function resolver(options: { mode?: 'direct' | 'disabled'; current?: Profile | null; containers?: { service: string; ports: Record<string, number> }[] } = {}) {
  return new ConfiguredBeeTargetResolver({ findByName: async () => options.current === undefined ? profile : options.current },
    { listApiContainers: async () => options.containers ?? [bee] }, options.mode);
}

describe('configured Bee target locator', () => {
  it('requires the runtime direct-mode assertion and exactly one saved Bee API port', async () => {
    for (const options of [{}, { mode: 'disabled' as const }, { mode: 'direct' as const, current: null },
      { mode: 'direct' as const, containers: [] }, { mode: 'direct' as const, containers: [bee, bee] },
      { mode: 'direct' as const, containers: [{ ...bee, ports: {} }] },
      ...[0, 65536, 1.5, NaN].map(port => ({ mode: 'direct' as const, containers: [{ ...bee, ports: { BEE_UPLOADER_API_PORT: port } }] }))]) {
      await assert.rejects(resolver(options).resolve('deployment'), error => error instanceof Error && error.name === 'ChequebookPreparationError');
    }
  });

  it('uses the configured service port and labels the topology as an operator assertion', async () => {
    const result = await resolver({ mode: 'direct' }).resolve('deployment');
    assert.equal(result.url, 'http://bee-host:12005/');
    assert.equal(result.topology, 'operator_asserted_direct');
    assert.ok(result.revision);
  });

  it('preserves hostnames and SSH aliases, removes the SSH username and handles local hostnames', async () => {
    for (const [host, expected] of [['deploy@bee.example.invalid', 'bee.example.invalid'], ['bee-alias', 'bee-alias'], ['127.0.0.1', '127.0.0.1']]) {
      const result = await resolver({ mode: 'direct', current: { ...profile, host } }).resolve('deployment');
      assert.equal(new URL(result.url).hostname, expected);
      assert.equal(new URL(result.url).username, '');
    }
  });

  it('changes its revision for profile generation, host, port, status and stack changes', async () => {
    const baseline = await resolver({ mode: 'direct' }).resolve('deployment');
    for (const current of [{ ...profile, updated_at: new Date(1) }, { ...profile, created_at: new Date(1) },
      { ...profile, host: 'replacement' }, { ...profile, stack_version_id: 2 }, { ...profile, status: 'ERROR' as const }]) {
      assert.notEqual((await resolver({ mode: 'direct', current }).resolve('deployment')).revision, baseline.revision);
    }
    const changed = await resolver({ mode: 'direct', containers: [{ ...bee, ports: { BEE_UPLOADER_API_PORT: 12015 } }] }).resolve('deployment');
    assert.notEqual(changed.revision, baseline.revision);
  });

  it('refuses known lifecycle transitions and profiles without their own Bee component', async () => {
    for (const current of ['DEPLOYING', 'STOPPING', 'REMOVING'].map(status => ({ ...profile, status } as Profile)).concat([{ ...profile, components: ['stream-uploader'] }])) {
      await assert.rejects(resolver({ mode: 'direct', current }).resolve('deployment'));
    }
  });
});
