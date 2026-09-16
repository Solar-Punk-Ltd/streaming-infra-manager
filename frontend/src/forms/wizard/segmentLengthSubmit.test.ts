/**
 * What the wizard's create body says about engine settings.
 *
 * Unit test, no DOM, the request captured off a mocked fetch the way the pool
 * submission test does it. `pnpm test` in frontend/.
 *
 * The body is the only door this value has. The settings route cannot take it
 * a moment after the deployment is made, because a profile is DEPLOYING from
 * the instant the create returns and that route refuses a busy deployment.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackVersion } from '@streaming-infra-manager/common';

import {
  initialWizardState,
  type WizardContext,
  type WizardGoal,
  type WizardState,
} from './wizardState';
import { submitWizard } from './wizardSubmit';

const context: WizardContext = {
  profiles: [],
  groups: [],
  serverHost: 'fixture.test',
  hostPassphrase: null,
  poolResults: new Map(),
  versions: [
    { id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion,
  ],
};

interface SentRequest {
  path: string;
  body: Record<string, unknown>;
}

function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState({ goal }, context), name: 'stage', ...over };
}

/** Where the wizard sent its one request, and what it put in it. */
async function sentRequest(
  t: { mock: { method: typeof import('node:test').mock.method } },
  state: WizardState,
): Promise<SentRequest> {
  let sent: SentRequest | null = null;
  t.mock.method(globalThis, 'fetch', async (path: unknown, init: RequestInit) => {
    sent = {
      path: String(path),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ name: 'stage' }), { status: 202 });
  });
  // A group and a pool each build their outcome from a whole valid response,
  // which is another test's subject. The request has already gone by the time
  // that is read, so failing to build one is not failing to send.
  await submitWizard(state, context).catch(() => undefined);
  if (!sent) throw new Error('the wizard sent no request');
  return sent;
}

describe('engine settings on the wizard create body', () => {
  it('carries the segment length an SRS stream was created with', async (t) => {
    const { body } = await sentRequest(t, stateFor('stream'));

    assert.deepEqual(body.engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('carries none for a viewer, which runs no media server', async (t) => {
    const { body } = await sentRequest(t, stateFor('viewer'));

    assert.equal('engine_settings' in body, false);
  });

  it('carries the segment length an ABR uploader was created with', async (t) => {
    // It runs SRS and no Bee node, so the key is read there exactly as it is
    // on a stream, and the wizard used to leave it out.
    const { body } = await sentRequest(t, stateFor('abr-uploader'));

    assert.deepEqual(body.engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('carries it on a group of streams, which posts to /groups', async (t) => {
    const { path, body } = await sentRequest(t, stateFor('stream', { group: true }));

    assert.equal(path, '/groups');
    assert.deepEqual(body.engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('carries none for a node pool, which runs no engine at all', async (t) => {
    const { path, body } = await sentRequest(t, stateFor('abr-pool'));

    assert.equal(path, '/groups');
    assert.equal('engine_settings' in body, false);
  });
});
