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
import { footerError, nameError, poolStringError, wizardError } from './wizardError';
import { initialWizardState, type WizardContext } from './wizardState';

/** A deployment that exists already. The name is all the taken-name check reads. */
function existing(name: string): Profile {
  return { name } as Profile;
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

describe('what is wrong with the segment length', () => {
  const settings = (segmentSeconds: string) => ({
    ...initialWizardState({ goal: 'stream' }, context),
    step: 3,
    name: 'stage',
    segmentSeconds,
  });

  it('stops the operator moving on, in the words the field shows', () => {
    assert.match(
      wizardError(settings('two'), context) ?? '',
      /Segment length must be a positive number/,
    );
  });

  it('lets the default through, and lets a cleared field through as well', () => {
    assert.equal(wizardError(settings('2'), context), null);
    assert.equal(wizardError(settings(''), context), null);
  });

  it('stops an ABR uploader on it too, now that it offers the field', () => {
    const uploader = {
      ...initialWizardState({ goal: 'abr-uploader' }, context),
      step: 3,
      name: 'stage',
      segmentSeconds: 'two',
    };

    assert.match(
      wizardError(uploader, context) ?? '',
      /Segment length must be a positive number/,
    );
  });
});

describe('the footer while a deployment is being created', () => {
  it('stops claiming the name is taken by the deployment being created', () => {
    // The manager announces a created deployment on the events stream before
    // the request that created it answers, so the wizard's own list gains the
    // name it is submitting and the footer read "That name is taken" about the
    // thing in flight, next to a Deploy button that had gone grey and a close
    // button that refused.
    const state = { ...basics('main-stage'), step: 4 };

    assert.equal(footerError(state, context, false), 'That name is taken');
    assert.equal(footerError(state, context, true), null);
  });

  it('is the ordinary answer whenever nothing is in flight', () => {
    const state = { ...basics(''), step: 4 };

    assert.equal(footerError(state, context, false), wizardError(state, context));
  });
});
