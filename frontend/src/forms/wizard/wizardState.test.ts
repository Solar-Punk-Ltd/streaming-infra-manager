/**
 * What a new deployment starts with before the operator touches anything,
 * tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The passphrase default is the one that matters here: on a host without a
 * shared passphrase, "use the host-wide passphrase" is unencrypted ingest,
 * and a default is what most deployments keep. The second suite is what the
 * Review step says about the choice, which has to match what the Publish
 * card says once the deployment runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import {
  chosenPassphrase,
  initialWizardState,
  needsPassphrase,
  passphraseSummary,
  withDefaultVersion,
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

  it('is recomputed from the host when a change of goal starts the settings over', () => {
    const context = hostWith(null);
    const state = withGoal(initialWizardState({ goal: 'viewer' }, context), 'stream', context);

    assert.equal(state.passMode, 'generate');
  });
});

describe('what the Review step says about the passphrase', () => {
  it('names the host-wide one when the host has one', () => {
    const context = hostWith('shared-by-the-host');

    assert.equal(
      passphraseSummary(initialWizardState({ goal: 'stream' }, context), context),
      'the host-wide passphrase',
    );
  });

  it('says the ingest is unencrypted when the host-wide one is chosen on a host without one', () => {
    // The choice stays offered, as D03 decided, and the Review says what the
    // Publish card will say afterwards, not the name of a passphrase that is
    // not there.
    const context = hostWith(null);
    const state = { ...initialWizardState({ goal: 'stream' }, context), passMode: 'host' as const };

    assert.equal(
      passphraseSummary(state, context),
      'none on this host, so the ingest is unencrypted',
    );
  });

  it('says generated, and your own', () => {
    const context = hostWith(null);
    const generated = initialWizardState({ goal: 'stream' }, context);

    assert.equal(passphraseSummary(generated, context), 'generated for this deployment');
    assert.equal(
      passphraseSummary({ ...generated, passMode: 'custom' }, context),
      'a passphrase of your own',
    );
  });
});


describe('the stack version of a wizard opened before the versions arrived', () => {
  const ready = (id: number, isDefault: boolean) =>
    ({ id, status: 'ready', isDefault, tested: true }) as StackVersion;
  const withVersions = (versions: StackVersion[]): WizardContext => ({
    ...hostWith(null),
    versions,
  });

  it('has none while the list the default is named in is still empty', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith(null));

    assert.equal(state.versionId, null);
  });

  it('takes the default once that list arrives', () => {
    const opened = initialWizardState({ goal: 'stream' }, hostWith(null));

    const settled = withDefaultVersion(opened, withVersions([ready(7, true)]));

    assert.equal(settled.versionId, 7);
  });

  it('leaves a version the operator chose alone', () => {
    const opened = initialWizardState({ goal: 'stream' }, hostWith(null));
    const chosen = { ...opened, versionId: 9 };

    const settled = withDefaultVersion(chosen, withVersions([ready(7, true), ready(9, false)]));

    assert.equal(settled.versionId, 9);
  });

  it('answers the state it was given when there is no default to adopt', () => {
    const opened = initialWizardState({ goal: 'stream' }, hostWith(null));

    assert.equal(withDefaultVersion(opened, withVersions([ready(7, false)])), opened);
  });
});
