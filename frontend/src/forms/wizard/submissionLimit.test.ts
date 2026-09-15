import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CREATE_TIMEOUT_MS,
  createTimedOutMessage,
  isSubmissionTimeout,
} from './submissionLimit';

describe('a create the dialog stops waiting for', () => {
  it('gives up in under a minute and a half, so the dialog is never held open for good', () => {
    assert.ok(CREATE_TIMEOUT_MS > 0 && CREATE_TIMEOUT_MS <= 90_000, String(CREATE_TIMEOUT_MS));
  });

  it('recognises the deadline it set, and nothing else', () => {
    assert.ok(isSubmissionTimeout(new DOMException('timed out', 'TimeoutError')));
    assert.ok(!isSubmissionTimeout(new Error('request failed (500)')));
    assert.ok(!isSubmissionTimeout(new DOMException('aborted', 'AbortError')));
    assert.ok(!isSubmissionTimeout(null));
  });

  it('says the deployment may exist rather than that it failed, because the manager keeps working', () => {
    const message = createTimedOutMessage('main-stage');
    assert.match(message, /main-stage/);
    assert.match(message, /may already/i);
    assert.doesNotMatch(message, /failed|could not be created/i);
  });
});
