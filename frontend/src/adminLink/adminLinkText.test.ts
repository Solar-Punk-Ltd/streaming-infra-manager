/**
 * What the page says for each outcome of Test connection: one plain sentence
 * each, and how loudly it says it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADMIN_LINK_TEST_OUTCOMES } from '@streaming-infra-manager/common';

import {
  ADMIN_LINK_OFF_NOTE,
  ADMIN_LINK_TEST_REACH,
  adminLinkTestSeverity,
  adminLinkTestText,
  storedTokenDetail,
} from './adminLinkText';

describe('the sentence for each Test connection outcome', () => {
  it('has one plain sentence for every outcome, with no dash or semicolon', () => {
    for (const outcome of ADMIN_LINK_TEST_OUTCOMES) {
      const text = adminLinkTestText(outcome);
      assert.match(text, /^[A-Z].*\.$/, outcome);
      assert.equal(text.split(/\.\s/).length, 1, `${outcome} is one sentence: ${text}`);
      assert.doesNotMatch(text, /[—;]/, outcome);
    }
  });

  it('says what each outcome means for the uploader', () => {
    assert.equal(adminLinkTestText('linked'), "Linked: the web2 admin took the token and signs its catalog with this deployment's stream address.");
    assert.equal(adminLinkTestText('token-refused'), 'The web2 admin answered but refused the token.');
    assert.equal(adminLinkTestText('unreachable'), 'The web2 admin did not answer from where the manager runs.');
    assert.equal(
      adminLinkTestText('stored-token-elsewhere'),
      "The manager's stored token was saved for another address, so it was not sent here, and only a token typed for this address can be tested.",
    );
    assert.equal(
      adminLinkTestText('owner-mismatch'),
      "The web2 admin took the token but signs its catalog with another address than this deployment's stream key, so the uploader will refuse to start.",
    );
  });

  it('says a success quietly and a refusal loudly', () => {
    assert.equal(adminLinkTestSeverity('linked'), 'success');
    assert.equal(adminLinkTestSeverity('token-accepted'), 'success');
    assert.equal(adminLinkTestSeverity('owner-unconfirmed'), 'warning');
    assert.equal(adminLinkTestSeverity('not-linked'), 'info');
    for (const outcome of ['owner-mismatch', 'token-refused', 'not-admin', 'redirected', 'unreachable', 'invalid-address', 'no-token', 'stored-token-elsewhere'] as const) {
      assert.equal(adminLinkTestSeverity(outcome), 'error', outcome);
    }
  });

  it("says what the wizard's switch does in each position, and where the stored token comes from", () => {
    assert.equal(
      ADMIN_LINK_OFF_NOTE,
      'Off, this deployment stores an empty ADMIN_API_URL, so its uploader runs standalone even when its version turns admin mode on.',
    );
    assert.equal(storedTokenDetail(true), 'The manager copies it into this deployment when it is created. It never reaches this page.');
    assert.equal(storedTokenDetail(false), 'The manager stores no token. Save one on Manager settings, or type one here.');
  });

  it('says in one line where the test runs from', () => {
    assert.equal(
      ADMIN_LINK_TEST_REACH,
      "The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here.",
    );
  });
});
