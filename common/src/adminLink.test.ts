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
} from './adminLink.js';
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

  it('refuses a token with no address, and an empty token, which clearing says with null', () => {
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: '', token: TOKEN }), [
      "A token needs the admin's address. Give the address, or leave the token out.",
    ]);
    assert.deepEqual(managerAdminLinkProblems({ expectedRevision: 0, url: ADMIN_URL, token: '' }), [
      'The token cannot be empty. Leave it out to keep the stored one, or clear it.',
    ]);
  });
});
