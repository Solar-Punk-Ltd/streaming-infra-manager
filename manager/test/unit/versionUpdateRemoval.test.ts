import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';

it('an update whose version disappears during markBuilding refuses before filesystem or script work', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 't04a-removed-update-'));
  const versions = new InMemoryStackVersionRepository();
  versions.seedBundled();
  const selected = await versions.insert({ name: 'review-stack', gitRef: 'review', rootPath: join(root, 'review-stack') });
  const runner = new FakeScriptSpawner();
  const service = new StackVersionService(versions, runner, new EventBus(), root, { openReferences: async () => [], pendingShipmentBuildIds: async () => [] });
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  versions.markBuilding = async () => { entered(); await resume; return null; };
  const pending = service.update(selected.id);
  try {
    await arrived;
    release();
    await assert.rejects(pending, { name: 'StackVersionNotFoundError' });
    assert.equal(runner.spawned.length, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { release(); await pending.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
