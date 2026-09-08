import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { StackVersion } from '@streaming-infra-manager/common';
import { initialWizardState, type WizardContext } from './wizardState';
import { submitWizard } from './wizardSubmit';

const context: WizardContext = { profiles: [], groups: [], serverHost: 'fixture.test', hostPassphrase: null,
  poolResults: new Map(), versions: [{ id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion] };
const state = { ...initialWizardState({ goal: 'abr-pool' }, context), name: 'chosen-pool' };

it('validates accepted pool JSON before constructing a route and never repeats the request', async t => {
  let calls = 0;
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(value), { status: 202 }); });
  for (value of [null, {}, { group: null, profiles: [] }, { group: { id: 79 }, profiles: null }]) {
    await assert.rejects(submitWizard(state, context), error => error instanceof Error &&
      error.name === 'PoolResponseError' && /accepted.*could not select/.test(error.message));
  }
  assert.equal(calls, 4);
});
