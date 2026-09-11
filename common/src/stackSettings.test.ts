/**
 * The rules the settings page and the manager both apply to a settings key.
 *
 * Unit test, `pnpm test` in common/. The two rules live here rather than in
 * either side because a key the manager calls a secret and the page does not
 * would be shown in the clear, and a key the page calls generated and the
 * manager does not would carry a promise nothing keeps.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NAMED_SECRET_SETTING_KEYS,
  PER_DEPLOYMENT_SETTING_KEYS,
  isGeneratedSettingKey,
  isSecretSettingKey,
} from './stackSettings.js';

describe('isSecretSettingKey', () => {
  it('holds every secret-like key the stack ships today', () => {
    for (const key of [
      'STREAM_KEY',
      'API_AUTH_TOKEN',
      'PUBLISH_KEY_SECRET',
      'SRT_PASSPHRASE',
      'SRS_WEBHOOK_TOKEN',
      'OME_ADMISSION_SECRET',
    ]) {
      assert.equal(isSecretSettingKey(key), true, key);
    }
  });

  it('names those six by name, so a change to the suffixes cannot unmask one', () => {
    assert.deepEqual([...NAMED_SECRET_SETTING_KEYS].sort(), [
      'API_AUTH_TOKEN',
      'OME_ADMISSION_SECRET',
      'PUBLISH_KEY_SECRET',
      'SRS_WEBHOOK_TOKEN',
      'SRT_PASSPHRASE',
      'STREAM_KEY',
    ]);
  });

  it('holds a key a later version of the stack adds under one of the suffixes', () => {
    for (const key of [
      'ADMIN_TOKEN',
      'WEBHOOK_SECRET',
      'RELAY_PASSPHRASE',
      'DB_PASSWORD',
      'SIGNING_KEY',
    ]) {
      assert.equal(isSecretSettingKey(key), true, key);
    }
  });

  it('leaves a key that only reads like one alone', () => {
    for (const key of [
      'API_PORT',
      'STAMP',
      'KEYFRAME_INTERVAL',
      'TOKEN_BUCKET_SIZE',
      'SECRETS_DIR',
      'ENGINE',
    ]) {
      assert.equal(isSecretSettingKey(key), false, key);
    }
  });
});

describe('isGeneratedSettingKey', () => {
  const required = ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'];

  it('holds every required secret of the version', () => {
    assert.equal(isGeneratedSettingKey('API_AUTH_TOKEN', required), true);
    assert.equal(isGeneratedSettingKey('SRS_WEBHOOK_TOKEN', required), true);
  });

  it('holds the two the manager writes per deployment whatever the contract says', () => {
    assert.deepEqual([...PER_DEPLOYMENT_SETTING_KEYS], ['SRT_PASSPHRASE', 'STREAM_KEY']);
    assert.equal(isGeneratedSettingKey('SRT_PASSPHRASE', []), true);
    assert.equal(isGeneratedSettingKey('STREAM_KEY', []), true);
  });

  it('leaves a secret the operator sets alone', () => {
    assert.equal(isGeneratedSettingKey('PUBLISH_KEY_SECRET', required), false);
    assert.equal(isGeneratedSettingKey('API_AUTH_TOKEN', []), false);
  });
});
