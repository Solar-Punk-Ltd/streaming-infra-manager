/**
 * What a new deployment starts with before the operator touches anything,
 * tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The passphrase default is the one that matters here: on a host without a
 * shared passphrase, "use the host-wide passphrase" is unencrypted ingest,
 * and a default is what most deployments keep.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chosenPassphrase,
  initialWizardState,
  needsPassphrase,
  withGoal,
  type WizardContext,
} from './wizardState';

function hostWith(hostPassphrase: string | null): WizardContext {
  return {
    profiles: [],
    groups: [],
    serverHost: 'stream.example',
    hostPassphrase,
    poolResults: new Map(),
    versions: [],
  };
}

describe('the passphrase a new deployment starts with', () => {
  it('is the host-wide one when the host has one', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith('shared-by-the-host'));

    assert.equal(state.passMode, 'host');
    assert.equal(chosenPassphrase(state), null, 'null tells the manager to use the host-wide one');
  });

  it('is generated when the host has none, so the default is never unencrypted', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith(null));

    assert.equal(state.passMode, 'generate');
    assert.equal(chosenPassphrase(state), state.generatedPassphrase);
    // What the submit body sends as srt_passphrase, see sharedBody in wizardSubmit.
    assert.ok(needsPassphrase(state) && chosenPassphrase(state), 'a passphrase of its own is submitted');
  });

  it('is generated for an ABR uploader on such a host as well', () => {
    const state = initialWizardState({ goal: 'abr-uploader' }, hostWith(null));

    assert.ok(needsPassphrase(state) && chosenPassphrase(state) === state.generatedPassphrase);
  });

  it('is kept when the goal changes', () => {
    const context = hostWith(null);
    const state = withGoal(initialWizardState({ goal: 'viewer' }, context), 'stream', context);

    assert.equal(state.passMode, 'generate');
  });
});
