/**
 * What the settings page holds while it is being edited, and what it sends.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The page itself is rendered
 * by `frontend/test/version-settings-browser.test.mjs`.
 *
 * A save carries only what the operator changed. Sending every key back would
 * rewrite lines nobody touched, and the manager keeps those files byte for
 * byte precisely so an operator can still read the diff over ssh.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackSettings } from '@streaming-infra-manager/common';

import {
  draftOf,
  editedFiles,
  isAtSampleValue,
  settingsRefusal,
  withEntry,
  withRemoval,
  withText,
} from './settingsDraft';

const SETTINGS: StackSettings = {
  generation: 4,
  buildId: 'abc1234',
  buildGeneration: 4,
  leftAlone: [],
  files: [
    {
      path: '.env',
      kind: 'env',
      entries: [
        { key: 'API_PORT', value: '3000', sampleValue: '3000', description: '', secret: false, generated: false },
        { key: 'API_AUTH_TOKEN', value: 'kept', sampleValue: '', description: 'The token.', secret: true, generated: true },
        { key: 'EXTRA_LOCAL_KEY', value: 'own', sampleValue: null, description: '', secret: false, generated: false },
      ],
    },
    { path: 'deploy/config.json', kind: 'json', text: '{"a":1}', sampleText: '{}' },
  ],
};

describe('draftOf', () => {
  it('starts as what the manager answered', () => {
    assert.deepEqual(draftOf(SETTINGS), {
      '.env': {
        kind: 'env',
        values: { API_PORT: '3000', API_AUTH_TOKEN: 'kept', EXTRA_LOCAL_KEY: 'own' },
        removed: [],
      },
      'deploy/config.json': { kind: 'json', text: '{"a":1}' },
    });
  });

  it('is what Discard goes back to, removals included', () => {
    const draft = withRemoval(draftOf(SETTINGS), '.env', 'EXTRA_LOCAL_KEY');

    assert.deepEqual(editedFiles(SETTINGS, draft).length, 1);
    assert.deepEqual(editedFiles(SETTINGS, draftOf(SETTINGS)), []);
  });
});

describe('editedFiles', () => {
  it('sends nothing while nothing has been typed', () => {
    assert.deepEqual(editedFiles(SETTINGS, draftOf(SETTINGS)), []);
  });

  it('sends only the keys whose value moved', () => {
    const draft = withEntry(draftOf(SETTINGS), '.env', 'API_PORT', '3100');

    assert.deepEqual(editedFiles(SETTINGS, draft), [
      { path: '.env', entries: [{ key: 'API_PORT', value: '3100' }] },
    ]);
  });

  it('sends a json file only once its text differs', () => {
    const draft = withText(draftOf(SETTINGS), 'deploy/config.json', '{"a":2}');

    assert.deepEqual(editedFiles(SETTINGS, draft), [
      { path: 'deploy/config.json', text: '{"a":2}' },
    ]);
  });

  it('sends every file that moved in one save', () => {
    const draft = withText(
      withEntry(draftOf(SETTINGS), '.env', 'API_AUTH_TOKEN', 'new'),
      'deploy/config.json',
      '{}',
    );

    assert.deepEqual(editedFiles(SETTINGS, draft).map((file) => file.path), [
      '.env',
      'deploy/config.json',
    ]);
  });

  it('sends a key the operator removed as the removal it is', () => {
    const draft = withRemoval(draftOf(SETTINGS), '.env', 'EXTRA_LOCAL_KEY');

    assert.deepEqual(editedFiles(SETTINGS, draft), [
      { path: '.env', entries: [{ key: 'EXTRA_LOCAL_KEY', value: '', remove: true }] },
    ]);
  });

  it('sends a removal beside the values that moved in the same file', () => {
    const draft = withRemoval(withEntry(draftOf(SETTINGS), '.env', 'API_PORT', '3100'), '.env', 'EXTRA_LOCAL_KEY');

    assert.deepEqual(editedFiles(SETTINGS, draft), [
      {
        path: '.env',
        entries: [
          { key: 'API_PORT', value: '3100' },
          { key: 'EXTRA_LOCAL_KEY', value: '', remove: true },
        ],
      },
    ]);
  });

  it('leaves the draft it was given alone when a key is removed', () => {
    const draft = draftOf(SETTINGS);
    const edited = withRemoval(draft, '.env', 'EXTRA_LOCAL_KEY');

    assert.deepEqual(draft['.env']?.kind === 'env' && draft['.env'].removed, []);
    assert.notEqual(draft, edited);
  });

  it('leaves the draft it was given alone', () => {
    const draft = draftOf(SETTINGS);
    const edited = withEntry(draft, '.env', 'API_PORT', '3100');

    assert.equal(draft['.env']?.kind === 'env' && draft['.env'].values.API_PORT, '3000');
    assert.notEqual(draft, edited);
  });
});

describe('isAtSampleValue', () => {
  it('is true only where the value is the one the version ships', () => {
    assert.equal(isAtSampleValue({ value: '3000', sampleValue: '3000' }), true);
    assert.equal(isAtSampleValue({ value: '3100', sampleValue: '3000' }), false);
    assert.equal(isAtSampleValue({ value: 'kept', sampleValue: null }), false);
  });
});

describe('settingsRefusal', () => {
  it('says what to do about a revision somebody else moved', () => {
    const refusal = settingsRefusal('settings_changed', 'anything the manager said');

    assert.equal(refusal.retry, 'Reload');
    assert.match(refusal.message, /^Somebody changed these settings since you loaded them\./);
  });

  it('offers another go at a file an ssh session has open, in the manager own words', () => {
    const refusal = settingsRefusal('settings_locked', 'The host configuration in /srv/x is being edited.');

    assert.equal(refusal.retry, 'Try again');
    assert.equal(refusal.message, 'The host configuration in /srv/x is being edited.');
  });

  it('names what is building when a build holds the slot', () => {
    const refusal = settingsRefusal('stack_build_busy', 'main-v3 is building.');

    assert.equal(refusal.retry, null);
    assert.equal(refusal.message, 'main-v3 is building.');
  });

  it('passes anything else through as the manager put it', () => {
    assert.deepEqual(settingsRefusal(null, 'the network went away'), {
      message: 'the network went away',
      retry: null,
    });
  });
});
