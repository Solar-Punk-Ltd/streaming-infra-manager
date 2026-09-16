import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CREATE_TIMEOUT_MS } from '../forms/wizard/submissionLimit';
import { ACTION_TIMEOUT_MS, actionTimedOutMessage } from './actionLimit';

describe('the ceiling on a deployment action that never comes back', () => {
  it('is finite, and far longer than the wait on a create', () => {
    // nginx holds the action routes open for a day, so nothing below the
    // browser bounds them. A deploy on a fresh host takes many minutes, which
    // is why this sits well above the deadline the New deployment dialog uses.
    assert.ok(Number.isFinite(ACTION_TIMEOUT_MS), String(ACTION_TIMEOUT_MS));
    assert.ok(
      ACTION_TIMEOUT_MS > CREATE_TIMEOUT_MS,
      `${ACTION_TIMEOUT_MS}ms is not above the ${CREATE_TIMEOUT_MS}ms a create waits`,
    );
  });

  it('says the manager may still be running it, rather than that it failed', () => {
    const message = actionTimedOutMessage();
    assert.match(message, /may still be running/i);
    assert.match(message, /badge/i);
    assert.doesNotMatch(message, /failed|did not work|gave up/i);
  });
});
