/**
 * Where a deployment's Stack settings card offers Test connection, and what it
 * says while the two web2 admin keys hold changes that are not saved.
 *
 * The test on the card asks what the next deploy would give the uploader,
 * which is the saved values, and the stored token never leaves the manager.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingEntry } from '@streaming-infra-manager/common';

import { adminLinkTestAnchor, unsavedAdminLinkNote } from './adminLinkRow';

function entry(key: string, over: Partial<DeploymentSettingEntry> = {}): DeploymentSettingEntry {
  return {
    key, section: 'Admin mode', description: '', declared: true, secret: false, sampleValue: null, versionSet: true,
    versionValue: '', stored: false, storedValue: null, value: '', source: 'version', owner: null, field: null,
    services: ['stream-uploader'], running: 'same', engineSetting: null, ...over,
  };
}

describe('where the card offers Test connection', () => {
  it('after the later of the two keys, in the order the list gives them', () => {
    assert.equal(adminLinkTestAnchor([entry('LOG_LEVEL'), entry('ADMIN_API_URL'), entry('ADMIN_API_TOKEN'), entry('STAMP')]), 'ADMIN_API_TOKEN');
    assert.equal(adminLinkTestAnchor([entry('ADMIN_API_TOKEN'), entry('ADMIN_API_URL')]), 'ADMIN_API_URL');
  });

  it('after the address alone when the version declares no token', () => {
    assert.equal(adminLinkTestAnchor([entry('ADMIN_API_URL'), entry('LOG_LEVEL')]), 'ADMIN_API_URL');
  });

  it('nowhere for a version that declares no address, or one the list does not let the operator set', () => {
    assert.equal(adminLinkTestAnchor([entry('LOG_LEVEL'), entry('ADMIN_API_TOKEN')]), null);
    assert.equal(adminLinkTestAnchor([entry('ADMIN_API_URL', { declared: false })]), null);
    assert.equal(adminLinkTestAnchor([entry('ADMIN_API_URL', { owner: 'components' })]), null);
  });
});

describe('what the test says of changes that are not saved', () => {
  it('says the test uses the saved values while either key holds a change', () => {
    const note = 'The test uses what is saved, not the changes above that are not saved yet.';
    assert.equal(unsavedAdminLinkNote([{ key: 'ADMIN_API_URL', value: 'https://admin.example.com' }]), note);
    assert.equal(unsavedAdminLinkNote([{ key: 'ADMIN_API_TOKEN', value: null }]), note);
  });

  it('says nothing while neither does', () => {
    assert.equal(unsavedAdminLinkNote([]), null);
    assert.equal(unsavedAdminLinkNote([{ key: 'LOG_LEVEL', value: 'debug' }]), null);
  });
});
