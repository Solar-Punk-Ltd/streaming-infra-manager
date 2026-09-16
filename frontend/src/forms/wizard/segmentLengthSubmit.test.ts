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

import { initialWizardState, type WizardContext } from './wizardState';
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

/** The body of the one request the wizard sent. */
async function sentBody(
  t: { mock: { method: typeof import('node:test').mock.method } },
  goal: 'stream' | 'viewer',
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ name: 'stage' }), { status: 202 });
  });
  await submitWizard(
    { ...initialWizardState({ goal }, context), name: 'stage' },
    context,
  );
  return sent;
}

describe('engine settings on the wizard create body', () => {
  it('carries the segment length an SRS stream was created with', async (t) => {
    const body = await sentBody(t, 'stream');

    assert.deepEqual(body.engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('carries none for a viewer, which runs no media server', async (t) => {
    const body = await sentBody(t, 'viewer');

    assert.equal('engine_settings' in body, false);
  });
});
