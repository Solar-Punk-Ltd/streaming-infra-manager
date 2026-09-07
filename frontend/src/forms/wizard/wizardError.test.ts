/**
 * What the wizard says is wrong, tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The line under a field and the line next to the disabled Continue come
 * from one answer, so a name the wizard refuses is never "Looks good" under
 * the field while the footer says otherwise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../../types';
import { nameError, poolStringError, wizardError } from './wizardError';
import { initialWizardState, type WizardContext } from './wizardState';

function existing(name: string): Profile {
  return {
    name,
    port_slot: 1,
    kind: 'viewer',
    notes: null,
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    containers: [],
    stack_version_id: 1,
  };
}

const context: WizardContext = {
  profiles: [existing('main-stage')],
  groups: [],
  serverHost: 'stream.example',
  hostPassphrase: null,
  poolResults: new Map(),
  versions: [],
};

const basics = (name: string) => ({
  ...initialWizardState({ goal: 'stream' }, context),
  step: 2,
  name,
});

describe('what is wrong with the name', () => {
  it('is the same answer under the field and next to the disabled Continue', () => {
    const state = basics('Main Stage');

    const underTheField = nameError(state, context);

    assert.match(underTheField ?? '', /^Name: /);
    assert.equal(wizardError(state, context), underTheField);
  });

  it('says a taken name is taken, in both places', () => {
    const state = basics('main-stage');

    assert.equal(nameError(state, context), 'That name is taken');
    assert.equal(wizardError(state, context), 'That name is taken');
  });

  it('asks for a name in the footer when there is none', () => {
    // The field itself stays on its hint for an empty name, see BasicsStep.
    assert.equal(wizardError(basics(''), context), 'Enter a name');
    assert.equal(nameError(basics(''), context), 'Enter a name');
  });

  it('holds a pool name to the room its members need', () => {
    const state = { ...basics('a'.repeat(30)), goal: 'abr-pool' as const };

    assert.match(nameError(state, context) ?? '', /^Pool name: at most/);
    assert.equal(wizardError(state, context), nameError(state, context));
  });

  it('has nothing to say about a good name', () => {
    assert.equal(nameError(basics('second-stage'), context), null);
  });
});

describe('what is wrong with a pasted pool string', () => {
  it('is the same answer under the field and next to the disabled Continue', () => {
    const state = {
      ...initialWizardState({ goal: 'abr-uploader' }, context),
      step: 3,
      poolMode: 'paste' as const,
      poolString: 'not a pool string',
    };

    const underTheField = poolStringError(state.poolString);

    assert.match(underTheField ?? '', /^Pool string: /);
    assert.equal(wizardError(state, context), underTheField);
  });

  it('says nothing under an empty field, which the footer asks for on its own', () => {
    const state = {
      ...initialWizardState({ goal: 'abr-uploader' }, context),
      step: 3,
      poolMode: 'paste' as const,
      poolString: '',
    };

    assert.equal(poolStringError(''), null);
    assert.equal(wizardError(state, context), 'Paste the pool string, copied from a pool page');
  });
});
