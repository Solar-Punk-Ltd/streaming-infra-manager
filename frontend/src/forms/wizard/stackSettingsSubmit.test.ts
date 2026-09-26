/**
 * What the wizard's create body says about the new deployment's own stack
 * settings.
 *
 * Unit test, no DOM, the request captured off a mocked fetch the way the
 * segment length submit test does it. `pnpm test` in frontend/.
 *
 * The body carries the typed keys that the list read for the choices on
 * screen takes, and nothing else, so the manager checks exactly what the page
 * checked. It names the kind and the services that list was asked for, which
 * is what the manager checks the create against. Values typed before a list
 * was read for these choices are not sent unchecked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry, StackVersion } from '@streaming-infra-manager/common';

import type { NewDeploymentSettingsLoad } from '../../deployments/settings/useNewDeploymentSettings';
import { createdShapeOf, initialWizardState, type WizardContext, type WizardGoal, type WizardState } from './wizardState';
import { submitWizard } from './wizardSubmit';

const TOKEN = 'synthetic-admin-token-for-the-body';

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

const LIST: NewDeploymentSettingsLoad = {
  catalog: {
    versionId: 7,
    buildId: 'build-1',
    entries: [
      entry({ key: 'LOG_LEVEL', versionValue: 'info', value: 'info' }),
      entry({ key: 'ADMIN_API_TOKEN', secret: true, versionSet: false, source: 'unset' }),
      entry({ key: 'STAMP', owner: 'stamp', source: 'manager' }),
    ],
  },
  failure: null,
  reload: async () => undefined,
};

function contextWith(newDeploymentSettings: NewDeploymentSettingsLoad | undefined = LIST): WizardContext {
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

const TYPED = { ADMIN_API_TOKEN: TOKEN, LOG_LEVEL: 'debug' };

function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState({ goal }, contextWith()), name: 'stage', step: 4, stackSettings: TYPED, ...over };
}

interface SentRequest {
  path: string;
  body: Record<string, unknown>;
}

/** Where the wizard sent its one request and what it put in it, or null for none. */
async function sentRequest(
  t: { mock: { method: typeof import('node:test').mock.method } },
  state: WizardState,
  context = contextWith(),
): Promise<SentRequest | null> {
  let sent: SentRequest | null = null;
  t.mock.method(globalThis, 'fetch', async (path: unknown, init: RequestInit) => {
    sent = { path: String(path), body: JSON.parse(String(init.body)) as Record<string, unknown> };
    return new Response(JSON.stringify({ name: 'stage' }), { status: 202 });
  });
  // A group and a pool each build their outcome from a whole valid response,
  // which is another test's subject. The request has already gone by then.
  await submitWizard(state, context).catch(() => undefined);
  return sent;
}

async function bodyOf(t: Parameters<typeof sentRequest>[0], state: WizardState): Promise<SentRequest> {
  const sent = await sentRequest(t, state);
  assert.ok(sent, 'the wizard sent a request');
  return sent;
}

describe('stack settings on the wizard create body', () => {
  it('carries the typed keys on a single stream, in the order the list gives them', async (t) => {
    const { path, body } = await bodyOf(t, stateFor('stream'));

    assert.equal(path, '/profiles');
    assert.deepEqual(body.stack_settings, [
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'ADMIN_API_TOKEN', value: TOKEN },
    ]);
  });

  it('carries none when nothing is typed', async (t) => {
    const { body } = await bodyOf(t, stateFor('stream', { stackSettings: {} }));

    assert.equal('stack_settings' in body, false);
  });

  it('leaves out a typed key the list for these choices does not take', async (t) => {
    const { body } = await bodyOf(t, stateFor('stream', { stackSettings: { LOG_LEVEL: 'debug', SRS_LOG_TANK: 'file', STAMP: 'ab'.repeat(32) } }));

    assert.deepEqual(body.stack_settings, [{ key: 'LOG_LEVEL', value: 'debug' }]);
  });

  it('carries them on a group of streams, one list for every member', async (t) => {
    const { path, body } = await bodyOf(t, stateFor('stream', { group: true }));

    assert.equal(path, '/groups');
    assert.deepEqual(body.stack_settings, [
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'ADMIN_API_TOKEN', value: TOKEN },
    ]);
  });

  it('carries them on a node pool, one list for all four rungs', async (t) => {
    const { path, body } = await bodyOf(t, stateFor('abr-pool'));

    assert.equal(path, '/groups');
    assert.equal(body.abr_ladder, true);
    assert.deepEqual(body.stack_settings, [
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'ADMIN_API_TOKEN', value: TOKEN },
    ]);
  });

  it('carries them on a viewer and on an ABR uploader', async (t) => {
    for (const goal of ['viewer', 'abr-uploader'] as const) {
      const { body } = await bodyOf(t, stateFor(goal));

      assert.deepEqual(body.stack_settings, [
        { key: 'LOG_LEVEL', value: 'debug' },
        { key: 'ADMIN_API_TOKEN', value: TOKEN },
      ], goal);
      t.mock.restoreAll();
    }
  });

  it('sends nothing when values are typed and no list was read for these choices', async (t) => {
    const unread: NewDeploymentSettingsLoad = { catalog: null, failure: null, reload: async () => undefined };

    await assert.rejects(submitWizard(stateFor('stream'), contextWith(unread)), /Advanced settings/);
    assert.equal(await sentRequest(t, stateFor('stream'), contextWith(unread)), null);
  });

  it('names the kind and the services the list was asked for, which the manager checks against', async (t) => {
    const cases: [WizardGoal, Partial<WizardState>][] = [
      ['stream', {}],
      ['stream', { engine: 'ome' }],
      ['viewer', {}],
      ['abr-uploader', {}],
      ['custom', { components: ['srs', 'stream-uploader'] }],
    ];
    for (const [goal, over] of cases) {
      const state = stateFor(goal, over);
      const { body } = await bodyOf(t, state);
      const shape = createdShapeOf(state);

      assert.deepEqual({ kind: body.kind, components: body.components ?? null }, shape, goal);
      t.mock.restoreAll();
    }
  });
});
