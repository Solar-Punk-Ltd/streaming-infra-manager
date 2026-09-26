/**
 * The new-deployment wizard's Advanced settings: which settings list it asks
 * the manager for, what the segment length shows on the key it decides, what
 * stops Continue and Deploy, and what the review says.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The step itself is driven
 * in Chrome by `frontend/test/wizard-settings-browser.test.mjs`.
 *
 * The list is asked for the deployment exactly as its create body will
 * describe it, because the manager checks the create's settings against that
 * list. A typed value is checked only against a list read for the choices on
 * screen, and nothing a refusal or the review says repeats a value.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry, StackVersion } from '@streaming-infra-manager/common';

import type { NewDeploymentSettingsLoad } from '../../deployments/settings/useNewDeploymentSettings';
import {
  advancedSettingsError,
  advancedSettingsFoldLine,
  advancedSettingsSummary,
  controlValuesOf,
  newDeploymentSettingsPathOf,
} from './advancedSettings';
import { wizardError } from './wizardError';
import { initialWizardState, type WizardContext, type WizardGoal, type WizardState } from './wizardState';

function entry(overrides: Partial<DeploymentSettingEntry> & { key: string }): DeploymentSettingEntry {
  return {
    section: 'Stream Uploader',
    description: '',
    declared: true,
    secret: false,
    sampleValue: null,
    versionSet: true,
    versionValue: null,
    stored: false,
    storedValue: null,
    value: null,
    source: 'version',
    owner: null,
    field: null,
    services: ['stream-uploader'],
    running: 'not-running',
    ...overrides,
  };
}

const ENTRIES = [
  entry({ key: 'LOG_LEVEL', versionValue: 'info', value: 'info', field: { kind: 'choice', choices: ['debug', 'info', 'warn'] } }),
  entry({ key: 'MAX_QUEUE_SIZE', versionValue: '100', value: '100', field: { kind: 'integer', min: 1 } }),
  entry({ key: 'ADMIN_API_TOKEN', secret: true, versionSet: false, source: 'unset' }),
  entry({ key: 'STAMP', owner: 'stamp', source: 'manager' }),
  entry({ key: 'HLS_FRAGMENT', section: 'SRS Media Server', owner: 'engine-settings', source: 'manager', services: ['srs'] }),
];

function loaded(): NewDeploymentSettingsLoad {
  return { catalog: { versionId: 7, buildId: 'build-1', entries: ENTRIES }, failure: null, reload: async () => undefined };
}

function contextWith(newDeploymentSettings?: NewDeploymentSettingsLoad): WizardContext {
  return {
    profiles: [],
    groups: [],
    serverHost: 'fixture.test',
    hostPassphrase: null,
    beeRpcEndpoint: { configured: false, host: null },
    poolResults: new Map(),
    versions: [{ id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion],
    newDeploymentSettings,
  };
}

/** A goal on the settings step, named, on the seeded default version. */
function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState({ goal }, contextWith()), name: 'stage', step: 3, ...over };
}

function queryOf(path: string | null) {
  assert.ok(path, 'a list is asked for');
  const url = new URL(path, 'http://manager.test');
  return {
    path: url.pathname,
    kind: url.searchParams.get('kind'),
    components: url.searchParams.get('components'),
    host: url.searchParams.get('host'),
  };
}

describe('the settings list the wizard asks for', () => {
  it('asks nothing before the settings step, or without a goal or a version', () => {
    assert.equal(newDeploymentSettingsPathOf(stateFor('stream', { step: 2 })), null);
    assert.equal(newDeploymentSettingsPathOf(stateFor('stream', { goal: null })), null);
    assert.equal(newDeploymentSettingsPathOf(stateFor('stream', { versionId: null })), null);
  });

  it('asks for a stream on this host with the services it runs', () => {
    assert.deepEqual(queryOf(newDeploymentSettingsPathOf(stateFor('stream'))), {
      path: '/versions/7/settings-catalog',
      kind: 'streamer',
      components: 'srs,stream-uploader,bee-uploader',
      host: 'localhost',
    });
  });

  it('follows the engine a stream picks, so the engine sample is the one it will run', () => {
    assert.equal(queryOf(newDeploymentSettingsPathOf(stateFor('stream', { engine: 'ome' }))).components, 'ome,stream-uploader,bee-uploader');
  });

  it('asks for a viewer and an ABR uploader by their kind, which decides their services', () => {
    assert.deepEqual(
      [queryOf(newDeploymentSettingsPathOf(stateFor('viewer'))), queryOf(newDeploymentSettingsPathOf(stateFor('abr-uploader')))].map(
        ({ kind, components }) => ({ kind, components }),
      ),
      [
        { kind: 'viewer', components: null },
        { kind: 'abr-uploader', components: null },
      ],
    );
  });

  it('asks for a node pool as one of its rungs, each a Bee node alone', () => {
    const { kind, components } = queryOf(newDeploymentSettingsPathOf(stateFor('abr-pool')));

    assert.deepEqual({ kind, components }, { kind: 'custom', components: 'bee-uploader' });
  });

  it('asks for a custom deployment with the services ticked, on the host typed', () => {
    const state = stateFor('custom', { components: ['srs', 'stream-uploader'], host: 'custom', hostCustom: ' deploy@edge-1 ' });

    assert.deepEqual(queryOf(newDeploymentSettingsPathOf(state)), {
      path: '/versions/7/settings-catalog',
      kind: 'custom',
      components: 'srs,stream-uploader',
      host: 'deploy@edge-1',
    });
  });
});

describe('the segment length on the key it decides', () => {
  it('shows the segment length on HLS_FRAGMENT where the step offers one', () => {
    assert.deepEqual(controlValuesOf(stateFor('stream', { segmentSeconds: ' 2 ' })), { HLS_FRAGMENT: '2' });
    assert.deepEqual(controlValuesOf(stateFor('abr-uploader', { segmentSeconds: '1.5' })), { HLS_FRAGMENT: '1.5' });
  });

  it('shows nothing where the field is empty or not offered', () => {
    assert.deepEqual(controlValuesOf(stateFor('stream', { segmentSeconds: '' })), {});
    assert.deepEqual(controlValuesOf(stateFor('stream', { engine: 'ome', segmentSeconds: '2' })), {});
    assert.deepEqual(controlValuesOf(stateFor('viewer', { segmentSeconds: '2' })), {});
  });
});

describe('what stops the settings step and the deploy', () => {
  it('stops nothing when no advanced value is typed, whether or not the list was read', () => {
    assert.equal(advancedSettingsError(stateFor('stream'), contextWith()), null);
    assert.equal(advancedSettingsError(stateFor('stream'), contextWith(loaded())), null);
  });

  it('waits for the list before a typed value can be checked', () => {
    const typed = stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug' } });
    const reading: NewDeploymentSettingsLoad = { catalog: null, failure: null, reload: async () => undefined };

    assert.equal(advancedSettingsError(typed, contextWith()), "Advanced settings: reading this version's settings");
    assert.equal(advancedSettingsError(typed, contextWith(reading)), "Advanced settings: reading this version's settings");
  });

  it('says why the list could not be read', () => {
    const failed: NewDeploymentSettingsLoad = {
      catalog: null,
      failure: { message: 'Could not read the settings. The manager did not answer in time. Try again.', severity: 'warning' },
      reload: async () => undefined,
    };

    assert.equal(
      advancedSettingsError(stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug' } }), contextWith(failed)),
      'Advanced settings: Could not read the settings. The manager did not answer in time. Try again.',
    );
  });

  it('names a value the manager would refuse by its key alone', () => {
    const state = stateFor('stream', { stackSettings: { MAX_QUEUE_SIZE: '0', LOG_LEVEL: 'debug' } });

    assert.equal(advancedSettingsError(state, contextWith(loaded())), 'Advanced settings: One value cannot be used as written: MAX_QUEUE_SIZE');
  });

  it('never repeats a refused secret', () => {
    const mangled = 'synthetic/token&with|sed-syntax';
    const refused = advancedSettingsError(stateFor('stream', { stackSettings: { ADMIN_API_TOKEN: mangled } }), contextWith(loaded()));

    assert.equal(refused, 'Advanced settings: One value cannot be used as written: ADMIN_API_TOKEN');
  });

  it('lets through a typed key this list does not take, because the create leaves it out', () => {
    assert.equal(advancedSettingsError(stateFor('stream', { stackSettings: { SRS_LOG_TANK: 'file' } }), contextWith(loaded())), null);
  });

  it('is what the footer says on the settings step and on the review', () => {
    const typed = { stackSettings: { MAX_QUEUE_SIZE: '0' } };
    const expected = 'Advanced settings: One value cannot be used as written: MAX_QUEUE_SIZE';

    assert.equal(wizardError(stateFor('stream', { ...typed, step: 3 }), contextWith(loaded())), expected);
    assert.equal(wizardError(stateFor('stream', { ...typed, step: 4 }), contextWith(loaded())), expected);
  });
});

describe('what the review says about the advanced settings', () => {
  it('says nothing when none is typed', () => {
    assert.equal(advancedSettingsSummary(stateFor('stream'), contextWith(loaded())), null);
  });

  it('names the keys the create sets and never a value', () => {
    const state = stateFor('stream', { stackSettings: { ADMIN_API_TOKEN: 'synthetic-token-value', LOG_LEVEL: 'debug' } });

    assert.equal(
      advancedSettingsSummary(state, contextWith(loaded())),
      "LOG_LEVEL and ADMIN_API_TOKEN set for this deployment. Every other key keeps the version's value.",
    );
  });

  it('names a typed key these choices do not take as not sent', () => {
    const state = stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug', SRS_LOG_TANK: 'file' } });

    assert.equal(
      advancedSettingsSummary(state, contextWith(loaded())),
      "LOG_LEVEL set for this deployment. Every other key keeps the version's value. Not sent, because this version does not take it with these choices: SRS_LOG_TANK.",
    );
    assert.equal(
      advancedSettingsSummary(stateFor('stream', { stackSettings: { SRS_LOG_TANK: 'file' } }), contextWith(loaded())),
      "Every key keeps the version's value. Not sent, because this version does not take it with these choices: SRS_LOG_TANK.",
    );
  });

  it('says the list is still being read rather than guessing', () => {
    assert.equal(advancedSettingsSummary(stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug' } }), contextWith()), "Reading this version's settings.");
  });
});

describe('the line on the folded Advanced settings', () => {
  it('says what the fold holds while nothing is typed', () => {
    assert.equal(
      advancedSettingsFoldLine(stateFor('stream'), contextWith(loaded())),
      "Every key this version declares, for this deployment alone. Left alone, each keeps the version's value.",
    );
  });

  it('counts what the create sends, and names a value it cannot send first', () => {
    assert.equal(advancedSettingsFoldLine(stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug' } }), contextWith(loaded())), '1 setting changed');
    assert.equal(
      advancedSettingsFoldLine(stateFor('stream', { stackSettings: { MAX_QUEUE_SIZE: '0' } }), contextWith(loaded())),
      'One value cannot be used as written: MAX_QUEUE_SIZE',
    );
    assert.equal(advancedSettingsFoldLine(stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug' } }), contextWith()), "Reading this version's settings.");
  });
});
