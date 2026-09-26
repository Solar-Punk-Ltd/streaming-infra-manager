/**
 * The edit in progress on the manager's own web2 admin link, and what of it a
 * save and a test send. The token field starts empty, because no token ever
 * reaches the page: empty keeps the stored one, a value replaces it, and
 * Clear takes it out.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ManagerAdminLink } from '@streaming-infra-manager/common';

import {
  draftOf,
  managerAdminLinkChanged,
  managerAdminLinkDraftProblems,
  managerAdminLinkSaveOf,
  managerAdminLinkTestOf,
} from './managerAdminLinkDraft';

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';

const NONE: ManagerAdminLink = { url: null, tokenStored: false, revision: 0 };
const STORED: ManagerAdminLink = { url: ADMIN_URL, tokenStored: true, revision: 4 };

describe("the manager's web2 admin link draft", () => {
  it('starts from the stored address and an empty token field', () => {
    assert.deepEqual(draftOf(STORED), { url: ADMIN_URL, token: '', clearToken: false });
    assert.deepEqual(draftOf(NONE), { url: '', token: '', clearToken: false });
  });

  it('sends the address and keeps the stored token while the field is empty', () => {
    const draft = { ...draftOf(STORED), url: 'https://admin2.example.com' };
    assert.equal(managerAdminLinkChanged(STORED, draft), true);
    assert.deepEqual(managerAdminLinkSaveOf(STORED, draft), { expectedRevision: 4, url: 'https://admin2.example.com' });
  });

  it('replaces the token with a typed one, and clears it on Clear', () => {
    assert.deepEqual(managerAdminLinkSaveOf(STORED, { ...draftOf(STORED), token: TOKEN }), { expectedRevision: 4, url: ADMIN_URL, token: TOKEN });
    assert.deepEqual(managerAdminLinkSaveOf(STORED, { ...draftOf(STORED), clearToken: true }), { expectedRevision: 4, url: ADMIN_URL, token: null });
  });

  it('has nothing to save until something changed', () => {
    assert.equal(managerAdminLinkChanged(STORED, draftOf(STORED)), false);
    assert.equal(managerAdminLinkChanged(NONE, draftOf(NONE)), false);
  });

  it('names a problem the manager would refuse, repeating neither the address nor the token', () => {
    const problems = managerAdminLinkDraftProblems(STORED, { url: 'https://operator:synthetic-password@admin.example.com', token: 'short', clearToken: false });
    assert.deepEqual(problems, ['ADMIN_API_URL cannot carry a user name or a password.', 'ADMIN_API_TOKEN must be at least 32 characters.']);
  });

  it('tests the typed token, else the stored one, and nothing without a token or an address', () => {
    assert.deepEqual(managerAdminLinkTestOf(STORED, { ...draftOf(STORED), token: TOKEN }), { url: ADMIN_URL, token: { source: 'typed', value: TOKEN } });
    assert.deepEqual(managerAdminLinkTestOf(STORED, draftOf(STORED)), { url: ADMIN_URL, token: { source: 'stored' } });
    assert.equal(managerAdminLinkTestOf(STORED, { ...draftOf(STORED), clearToken: true }), null);
    assert.equal(managerAdminLinkTestOf(NONE, { url: ADMIN_URL, token: '', clearToken: false }), null);
    assert.equal(managerAdminLinkTestOf(STORED, { ...draftOf(STORED), url: '' }), null);
  });
});
