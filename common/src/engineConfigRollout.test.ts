/**
 * What the deployment card says about a config file rollout, by the state the
 * row carries. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ENGINE_CONFIG_STATES, rolloutNotice } from './engineConfigRollout.js';

const ON_FILE = { engine: 'SRS 6', hasConfig: true };

describe('rolloutNotice', () => {
  it('says nothing for a deployment that never had a rollout, or whose last one applied', () => {
    assert.equal(rolloutNotice(null, ON_FILE), null);
    assert.equal(rolloutNotice('applied', ON_FILE), null);
  });

  it('names the engine and what it is being recreated on while applying', () => {
    assert.equal(
      rolloutNotice('applying', ON_FILE)?.title,
      'Recreating SRS 6 on the new config file.',
    );
    assert.equal(
      rolloutNotice('applying', { engine: 'SRS 6', hasConfig: false })?.title,
      'Recreating SRS 6 on the template.',
    );
  });

  it('offers nothing while the engine is being recreated or watched, and shows no reason', () => {
    for (const state of ['applying', 'watching'] as const) {
      const notice = rolloutNotice(state, ON_FILE);
      assert.deepEqual(notice?.offers, [], state);
      assert.equal(notice?.showsReason, false, state);
      assert.equal(notice?.severity, 'info', state);
    }
  });

  it('shows the reason for a revert under way and a revert that happened, and offers nothing', () => {
    assert.equal(rolloutNotice('reverting', ON_FILE)?.title, 'Putting the previous config file back.');
    assert.equal(rolloutNotice('reverted', ON_FILE)?.title, 'The last config file was reverted.');
    for (const state of ['reverting', 'reverted'] as const) {
      const notice = rolloutNotice(state, ON_FILE);
      assert.equal(notice?.severity, 'warning', state);
      assert.equal(notice?.showsReason, true, state);
      assert.deepEqual(notice?.offers, [], state);
    }
  });

  it('offers verify now after a failure, which is what recreates the engine on what is stored', () => {
    const notice = rolloutNotice('failed', ON_FILE);
    assert.equal(notice?.severity, 'error');
    assert.equal(notice?.title, 'The last config file could not be applied.');
    assert.equal(notice?.showsReason, true);
    assert.deepEqual(notice?.offers, ['verify']);
  });

  it('offers both ways out of an interruption without assuming a restart', () => {
    const notice = rolloutNotice('interrupted', ON_FILE);
    assert.equal(notice?.severity, 'warning');
    assert.equal(notice?.title, 'The config rollout was interrupted.');
    assert.deepEqual(notice?.offers, ['verify', 'previous']);
  });

  it('offers verify now when the rollout was superseded before the file was verified', () => {
    const notice = rolloutNotice('superseded', ON_FILE);
    assert.equal(notice?.severity, 'info');
    assert.equal(notice?.title, 'The last config file was not verified.');
    assert.deepEqual(notice?.offers, ['verify']);
  });

  it('has an answer for every state the row can carry', () => {
    for (const state of ENGINE_CONFIG_STATES) {
      const notice = rolloutNotice(state, ON_FILE);
      if (state === 'applied') assert.equal(notice, null);
      else assert.ok(notice, state);
    }
  });
});
