/**
 * Which stack script is handed the feed and stamp overrides.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The stack validates the shape of every flag it is given, on every script it
 * ships, in _lib.sh's parse_profile_args. Only deploy.sh reads --feed-owner,
 * --feed-topic and --stamp-id, so passing them to stop.sh and health.sh made a
 * stored value the stack refuses fail those two as well. A deployment that
 * cannot be stopped is the worst shape there is, so the three go to the one
 * script that reads them and nowhere else.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('override-flags-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(process.env.SHLS_ROOT, { recursive: true });
writeFileSync(join(process.env.SHLS_ROOT, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const FEED_OWNER = `0x${'ab'.repeat(20)}`;
const FEED_TOPIC = 'swarm-stream';
const STAMP_ID = 'a'.repeat(64);
const OVERRIDE_FLAGS = ['--feed-owner', '--feed-topic', '--stamp-id'];

let nextName = 0;

function setup() {
  const profile = makeProfile({
    name: `flags-${++nextName}`,
    feed_owner: FEED_OWNER,
    feed_topic: FEED_TOPIC,
    stamp_id: STAMP_ID,
  });
  return { profile, ...orchestratorHarness([profile]) };
}

const overridesIn = (args: readonly string[]): string[] =>
  OVERRIDE_FLAGS.filter((flag) => args.some((arg) => arg.startsWith(`${flag}=`)));

describe('the feed and stamp overrides', () => {
  it('reach deploy.sh, which is the script that reads them', async () => {
    const h = setup();

    await h.orchestrator.startDeploy(h.profile, undefined);

    const run = h.runner.runs[0]!;
    assert.match(run.script, /\/deploy\.sh$/);
    assert.ok(run.args.includes(`--feed-owner=${FEED_OWNER}`), run.args.join(' '));
    assert.ok(run.args.includes(`--feed-topic=${FEED_TOPIC}`), run.args.join(' '));
    assert.ok(run.args.includes(`--stamp-id=${STAMP_ID}`), run.args.join(' '));
  });

  it('do not reach stop.sh, which would refuse a stored topic it dislikes', async () => {
    const h = setup();

    await h.orchestrator.startStop(h.profile, undefined);

    const run = h.runner.runs[0]!;
    assert.match(run.script, /\/stop\.sh$/);
    assert.deepEqual(overridesIn(run.args), []);
    // What stop.sh does read is untouched.
    assert.ok(run.args.includes(`--profile=${h.profile.name}`), run.args.join(' '));
    assert.ok(run.args.includes(`--portSlot=${h.profile.port_slot}`), run.args.join(' '));
  });

  it('do not reach health.sh either', async () => {
    const h = setup();

    await h.orchestrator.startHealth(h.profile);

    const run = h.runner.runs[0]!;
    assert.match(run.script, /\/health\.sh$/);
    assert.deepEqual(overridesIn(run.args), []);
    assert.ok(run.args.includes(`--profile=${h.profile.name}`), run.args.join(' '));
  });
});
