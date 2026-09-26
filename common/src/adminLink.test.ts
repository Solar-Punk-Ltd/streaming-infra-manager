/**
 * The rule a deployment's two web2 admin keys answer to together.
 *
 * `ADMIN_API_URL` alone turns the stream uploader's admin mode on, and in admin
 * mode the uploader refuses to start without `ADMIN_API_TOKEN`. So a setting of
 * the two that leaves an address and no token is one the uploader refuses, and
 * the manager refuses it before it gets that far.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  type AdminLinkBefore,
  adminLinkAfterEdits,
  adminLinkEditProblem,
  adminLinkProblem,
  sameAdminOrigin,
  storedTokenMoveProblem,
} from './adminLink.js';
import { ADMIN_LINK_TEST_OUTCOMES, adminLinkTestProblems } from './adminLinkTest.js';
import { managerAdminLinkProblems } from './managerAdminLink.js';

const ADMIN_URL = 'https://admin.example.com';

/** Nothing set now, and the version sets nothing either. */
const NOTHING: AdminLinkBefore = { url: { current: '', afterReset: '' }, token: { current: false, afterReset: false } };

describe('the web2 admin link rule', () => {
  it('names the two keys it is about', () => {
    assert.equal(ADMIN_API_URL_KEY, 'ADMIN_API_URL');
    assert.equal(ADMIN_API_TOKEN_KEY, 'ADMIN_API_TOKEN');
  });

  it('refuses an address with no token, naming both keys', () => {
    const problem = adminLinkProblem({ url: 'https://admin.example.com', hasToken: false });
    assert.equal(
      problem,
      'ADMIN_API_URL is set and ADMIN_API_TOKEN is not, and the stream uploader refuses to start that way. Set ADMIN_API_TOKEN, or leave ADMIN_API_URL empty.',
    );
  });

  it('takes an address with a token', () => {
    assert.equal(adminLinkProblem({ url: 'https://admin.example.com', hasToken: true }), null);
  });

  it('takes no address, with or without a token, which leaves the uploader standalone', () => {
    assert.equal(adminLinkProblem({ url: '', hasToken: false }), null);
    assert.equal(adminLinkProblem({ url: '', hasToken: true }), null);
  });
});

describe('the two keys once edits land', () => {
  it('takes a typed value for either key over what was there', () => {
    assert.deepEqual(
      adminLinkAfterEdits([{ key: ADMIN_API_URL_KEY, value: ADMIN_URL }, { key: ADMIN_API_TOKEN_KEY, value: 'a'.repeat(32) }], NOTHING),
      { url: ADMIN_URL, hasToken: true },
    );
  });

  it('keeps what was there for a key the edits leave out', () => {
    const before: AdminLinkBefore = { url: { current: ADMIN_URL, afterReset: '' }, token: { current: true, afterReset: false } };
    assert.deepEqual(adminLinkAfterEdits([{ key: 'LOG_LEVEL', value: 'debug' }], before), { url: ADMIN_URL, hasToken: true });
  });

  it('puts back what the version gives for a key the edits reset', () => {
    const before: AdminLinkBefore = { url: { current: '', afterReset: ADMIN_URL }, token: { current: true, afterReset: false } };
    assert.deepEqual(
      adminLinkAfterEdits([{ key: ADMIN_API_URL_KEY, value: null }, { key: ADMIN_API_TOKEN_KEY, value: null }], before),
      { url: ADMIN_URL, hasToken: false },
    );
  });

  it('reads an empty typed token as no token', () => {
    const before: AdminLinkBefore = { url: { current: ADMIN_URL, afterReset: ADMIN_URL }, token: { current: true, afterReset: true } };
    assert.equal(adminLinkAfterEdits([{ key: ADMIN_API_TOKEN_KEY, value: '' }], before).hasToken, false);
  });

  it('judges only edits that name either key', () => {
    const broken: AdminLinkBefore = { url: { current: ADMIN_URL, afterReset: ADMIN_URL }, token: { current: false, afterReset: false } };
    assert.equal(adminLinkEditProblem([{ key: 'LOG_LEVEL', value: 'debug' }], broken), null);
    assert.match(adminLinkEditProblem([{ key: ADMIN_API_URL_KEY, value: ADMIN_URL }], broken) ?? '', /ADMIN_API_URL is set and ADMIN_API_TOKEN is not/);
  });
});

describe('the address a stored token may go to', () => {
  it('is the one it was stored with, however its scheme and host are cased or its default port written', () => {
    assert.equal(sameAdminOrigin('HTTPS://Admin.Example.com:443/some/path', 'https://admin.example.com'), true);
    assert.equal(sameAdminOrigin('http://[::1]:80/', 'http://[0:0:0:0:0:0:0:1]'), true);
  });

  it('is never another scheme, host or port', () => {
    assert.equal(sameAdminOrigin('http://admin.example.com', 'https://admin.example.com'), false);
    assert.equal(sameAdminOrigin('https://admin.example.com.evil.test', 'https://admin.example.com'), false);
    assert.equal(sameAdminOrigin('https://admin.example.com:8443', 'https://admin.example.com'), false);
    assert.equal(sameAdminOrigin('https://admin.example.com.', 'https://admin.example.com'), false);
  });

  it('is nowhere for an address that has no origin, or none at all', () => {
    assert.equal(sameAdminOrigin('', ''), false);
    assert.equal(sameAdminOrigin('https://admin.example.com', ''), false);
    assert.equal(sameAdminOrigin('not an address', 'not an address'), false);
    assert.equal(sameAdminOrigin('file:///etc/admin', 'file:///etc/admin'), false);
  });
});

describe("a save that moves a deployment's address away from its stored token", () => {
  const TOKEN = 'synthetic-admin-token-0123456789abcdef';
  const STORED = { url: ADMIN_URL, tokenStored: true };
  const MOVED =
    'ADMIN_API_URL moves to another address than the one ADMIN_API_TOKEN was stored with, and the manager sends a stored token only to the address it was stored with. Type ADMIN_API_TOKEN again for the new address, or clear it.';

  it('is refused when the token stays behind, and the sentence repeats neither value', () => {
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: 'https://elsewhere.example.net' }], STORED), MOVED);
  });

  it('is refused for a reset that puts back another address', () => {
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: null }], { ...STORED, afterReset: 'https://elsewhere.example.net' }), MOVED);
  });

  it('is refused for an address set where there was none, since the token was stored with none', () => {
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: ADMIN_URL }], { url: '', tokenStored: true }), MOVED);
  });

  it('is taken with a new token, a cleared one or a reset one', () => {
    const moved = { key: ADMIN_API_URL_KEY, value: 'https://elsewhere.example.net' };
    assert.equal(storedTokenMoveProblem([moved, { key: ADMIN_API_TOKEN_KEY, value: TOKEN }], STORED), null);
    assert.equal(storedTokenMoveProblem([moved, { key: ADMIN_API_TOKEN_KEY, value: '' }], STORED), null);
    assert.equal(storedTokenMoveProblem([moved, { key: ADMIN_API_TOKEN_KEY, value: null }], STORED), null);
  });

  it('is taken on the same origin, when the address is emptied, and when no token is stored', () => {
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: `${ADMIN_URL}/v2` }], STORED), null);
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: '' }], STORED), null);
    assert.equal(storedTokenMoveProblem([{ key: ADMIN_API_URL_KEY, value: 'https://elsewhere.example.net' }], { url: ADMIN_URL, tokenStored: false }), null);
    assert.equal(storedTokenMoveProblem([{ key: 'LOG_LEVEL', value: 'debug' }], STORED), null);
  });
});

describe("a save of the manager's own web2 admin link", () => {
  const TOKEN = 'synthetic-admin-token-0123456789abcdef';

  it('takes an address with a token, an address alone, and no address at all', () => {
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN }), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL }), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL, token: null }), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: '' }), []);
  });

  it('holds the address and the token to the rules a deployment holds them to, repeating neither', () => {
    const problems = managerAdminLinkProblems({
      expectedRevision: 0,
      url: 'https://operator:synthetic-password@admin.example.com',
      token: 'synthetic-short-token',
    });
    assert.deepEqual(problems, [
      'ADMIN_API_URL cannot carry a user name or a password.',
      'ADMIN_API_TOKEN must be at least 32 characters.',
    ]);
  });

  it('refuses a token with the characters the stack splices through sed, without repeating it', () => {
    const problems = managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL, token: 'synthetic/token&with|sed-syntax-0123456789' });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^ADMIN_API_TOKEN must not contain/);
    assert.doesNotMatch(problems[0] ?? '', /sed-syntax-0123456789/);
  });

  it('refuses an address on another origin that would keep the stored token, and takes one with a new or cleared token', () => {
    const stored = { url: ADMIN_URL, tokenStored: true };
    const elsewhere = 'https://elsewhere.example.net';
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: elsewhere }, stored), [
      'The address moves to another one than the stored token was saved with, and the manager sends its stored token only to the address it was saved with. Type the token again for the new address, or clear it.',
    ]);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: elsewhere, token: TOKEN }, stored), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: elsewhere, token: null }, stored), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: `${ADMIN_URL}/v2` }, stored), []);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: elsewhere }, { url: ADMIN_URL, tokenStored: false }), []);
  });

  it('refuses a token with no address, and an empty token, which clearing says with null', () => {
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: '', token: TOKEN }), [
      "A token needs the admin's address. Give the address, or leave the token out.",
    ]);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL, token: '' }), [
      'The token cannot be empty. Leave it out to keep the stored one, or clear it.',
    ]);
  });
});

describe('a request to test a web2 admin link typed on a page', () => {
  const TOKEN = 'synthetic-admin-token-0123456789abcdef';

  it('takes an address with a typed token or the stored one', () => {
    assert.deepEqual(adminLinkTestProblems({ url: ADMIN_URL, token: { source: 'typed', value: TOKEN } }), []);
    assert.deepEqual(adminLinkTestProblems({ url: ADMIN_URL, token: { source: 'stored' } }), []);
  });

  it('asks for an address, and for a typed token that the uploader would take, repeating neither', () => {
    assert.deepEqual(adminLinkTestProblems({ url: '', token: { source: 'typed', value: '' } }), [
      'Type the address of the web2 admin to test.',
      'Type a token to test with, or test with the stored one.',
    ]);
    assert.deepEqual(adminLinkTestProblems({ url: 'ftp://admin.example.com', token: { source: 'typed', value: 'synthetic-short-token' } }), [
      'ADMIN_API_URL must be an http or https address, such as https://admin.example.com.',
      'ADMIN_API_TOKEN must be at least 32 characters.',
    ]);
  });

  it('knows every outcome the page has a sentence for', () => {
    assert.deepEqual([...ADMIN_LINK_TEST_OUTCOMES].sort(), [
      'invalid-address', 'linked', 'no-token', 'not-admin', 'not-linked', 'owner-mismatch',
      'owner-unconfirmed', 'redirected', 'stored-token-elsewhere', 'token-accepted', 'token-refused', 'unreachable',
    ]);
  });
});
