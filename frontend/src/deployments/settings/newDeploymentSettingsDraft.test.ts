/**
 * What the new-deployment wizard holds while its Advanced settings are edited,
 * and what the create sends.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The editor itself is
 * rendered by `frontend/test/wizard-settings-browser.test.mjs`.
 *
 * Nothing is stored yet, so there is no revision and no reset: a key the
 * operator leaves alone, or puts back to the version's value, is simply not
 * sent, and its version's value is what the first deploy writes. A typed key
 * the list for the current choices does not take is kept aside rather than
 * sent, so a version or an engine chosen afterwards cannot turn it into a
 * refused create.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import {
  newDeploymentSettingsOf,
  newValueProblems,
  valuesNotTaken,
  withNewValue,
  withoutNewValue,
} from './newDeploymentSettingsDraft';

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
    engineSetting: null,
    ...overrides,
  };
}

const LOG_LEVEL = entry({
  key: 'LOG_LEVEL',
  versionValue: 'info',
  value: 'info',
  field: { kind: 'choice', choices: ['debug', 'log', 'info', 'warn', 'error', 'silent'] },
});
const MAX_QUEUE_SIZE = entry({ key: 'MAX_QUEUE_SIZE', versionValue: '100', value: '100', field: { kind: 'integer', min: 1 } });
const ADMIN_API_URL = entry({ key: 'ADMIN_API_URL', versionValue: '', value: '' });
const ADMIN_API_TOKEN = entry({ key: 'ADMIN_API_TOKEN', secret: true, versionSet: false, source: 'unset' });
const STAMP = entry({ key: 'STAMP', owner: 'stamp', source: 'manager' });
const HLS_FRAGMENT = entry({ key: 'HLS_FRAGMENT', section: 'SRS Media Server', owner: 'engine-settings', source: 'manager', services: ['srs'] });

const ENTRIES = [LOG_LEVEL, MAX_QUEUE_SIZE, ADMIN_API_URL, ADMIN_API_TOKEN, STAMP, HLS_FRAGMENT];

describe('typing a value for a new deployment', () => {
  it('keeps a value that differs from the version', () => {
    assert.deepEqual(withNewValue({}, ENTRIES, 'LOG_LEVEL', 'debug'), { LOG_LEVEL: 'debug' });
  });

  it('takes the key out when the value is the version value again, so nothing is sent for it', () => {
    const typed = withNewValue({}, ENTRIES, 'LOG_LEVEL', 'debug');

    assert.deepEqual(withNewValue(typed, ENTRIES, 'LOG_LEVEL', 'info'), {});
  });

  it('takes a secret out when its field is emptied, because empty means the version keeps it', () => {
    const typed = withNewValue({}, ENTRIES, 'ADMIN_API_TOKEN', 'synthetic-token');

    assert.deepEqual(typed, { ADMIN_API_TOKEN: 'synthetic-token' });
    assert.deepEqual(withNewValue(typed, ENTRIES, 'ADMIN_API_TOKEN', ''), {});
  });

  it('ignores a key a control decides and a key the list does not name', () => {
    assert.deepEqual(withNewValue({}, ENTRIES, 'STAMP', 'ab'.repeat(32)), {});
    assert.deepEqual(withNewValue({}, ENTRIES, 'HLS_FRAGMENT', '2'), {});
    assert.deepEqual(withNewValue({}, ENTRIES, 'NOT_LISTED', 'x'), {});
  });

  it('keeps an empty value for a key the version sets to something, because empty is a value of its own', () => {
    assert.deepEqual(withNewValue({}, ENTRIES, 'MAX_QUEUE_SIZE', ''), { MAX_QUEUE_SIZE: '' });
  });

  it('forgets a key on undo, and leaves the rest alone', () => {
    const typed = { LOG_LEVEL: 'debug', MAX_QUEUE_SIZE: '250' };

    assert.deepEqual(withoutNewValue(typed, 'LOG_LEVEL'), { MAX_QUEUE_SIZE: '250' });
    assert.equal(withoutNewValue(typed, 'NOT_TYPED'), typed);
  });
});

describe('what the create sends', () => {
  it('sends the typed keys the list takes, in the order the list gives them', () => {
    const typed = { MAX_QUEUE_SIZE: '250', ADMIN_API_TOKEN: 'synthetic-token', LOG_LEVEL: 'debug' };

    assert.deepEqual(newDeploymentSettingsOf(ENTRIES, typed), [
      { key: 'LOG_LEVEL', value: 'debug' },
      { key: 'MAX_QUEUE_SIZE', value: '250' },
      { key: 'ADMIN_API_TOKEN', value: 'synthetic-token' },
    ]);
  });

  it('keeps aside a typed key the list no longer takes, and sends none of it', () => {
    // Typed under another version or engine, whose list declared both.
    const typed = { LOG_LEVEL: 'debug', SRS_LOG_TANK: 'file', STAMP: 'ab'.repeat(32) };

    assert.deepEqual(newDeploymentSettingsOf(ENTRIES, typed), [{ key: 'LOG_LEVEL', value: 'debug' }]);
    assert.deepEqual(valuesNotTaken(ENTRIES, typed), ['SRS_LOG_TANK', 'STAMP']);
  });

  it('sends nothing for a typed key that is the version value in the list chosen since', () => {
    const typed = { LOG_LEVEL: 'info' };

    assert.deepEqual(newDeploymentSettingsOf(ENTRIES, typed), []);
    assert.deepEqual(valuesNotTaken(ENTRIES, typed), []);
  });
});

describe('what the manager would refuse', () => {
  it('names each refused key with the reason the manager gives, by its shared rules', () => {
    const problems = newValueProblems(ENTRIES, { MAX_QUEUE_SIZE: '0', LOG_LEVEL: 'loud', ADMIN_API_URL: 'http://admin.internal' });

    assert.deepEqual(problems, {
      LOG_LEVEL: 'LOG_LEVEL must be one of debug, log, info, warn, error, silent. Got "loud".',
      MAX_QUEUE_SIZE: 'MAX_QUEUE_SIZE must be at least 1. Got 0.',
    });
  });

  it('never repeats a refused secret', () => {
    const mangled = 'synthetic/token&with|sed-syntax';
    const problems = newValueProblems(ENTRIES, { ADMIN_API_TOKEN: mangled });

    assert.match(problems.ADMIN_API_TOKEN ?? '', /^This value must not contain/);
    assert.equal(JSON.stringify(problems).includes(mangled), false);
  });

  it('judges only what would be sent', () => {
    assert.deepEqual(newValueProblems(ENTRIES, { SRS_LOG_TANK: 'bad\nvalue' }), {});
  });
});
