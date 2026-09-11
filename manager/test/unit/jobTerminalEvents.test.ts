import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('t10-terminal-events-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

for (const order of [['done', 'error'], ['error', 'done'], ['done', 'done']] as const) {
  it(`finalizes a job once when ${order.join(' then ')} arrive before its first write finishes`, async () => {
    const h = orchestratorHarness([makeProfile({ name: 'owned' })]);
    const writes: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const markTerminal = h.profiles.markTerminal.bind(h.profiles);
    const markError = h.profiles.markError.bind(h.profiles);
    h.profiles.markTerminal = async (...args) => { writes.push('done'); await held; return markTerminal(...args); };
    h.profiles.markError = async (...args) => { writes.push('error'); await held; return markError(...args); };
    await h.orchestrator.startStop(h.profiles.rows.get('owned')!, undefined);
    const settled = new Promise<void>(resolve => {
      const unsubscribe = h.events.subscribe(event => {
        if (event.type === 'profile.changed' && ['STOPPED', 'ERROR'].includes(event.profile.status)) {
          unsubscribe();
          resolve();
        }
      });
    });
    try {
      for (const event of order) {
        if (event === 'done') h.runner.finish(0);
        else h.runner.abort(0, 'synthetic spawn failure');
      }
      assert.deepEqual(writes, [order[0]], 'a second terminal notification cannot enter finalization');
    } finally {
      release();
      await settled;
    }
    assert.equal(h.profiles.statusOf('owned'), order[0] === 'done' ? 'STOPPED' : 'ERROR');
  });
}
