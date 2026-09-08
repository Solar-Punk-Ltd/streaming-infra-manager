/**
 * What a page may know about a deploy attempt, and the two rules the manager
 * and the pages apply the same way: how an unresolved attempt reads in words,
 * and what has to be typed to release one.
 *
 * The release rule has teeth. An attempt is blocked because the manager could
 * not prove its build finished, so releasing it lets the next deploy build
 * beside a build that may still be running. Typing the job id back is what
 * separates a person who checked the host from a click.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attemptReleaseProblem,
  describeAttemptHold,
  type DeployAttemptView,
} from './deployAttempts.js';

const BLOCKED: DeployAttemptView = {
  id: 7,
  project: 'stage',
  jobId: 'job-abc123',
  kind: 'shared',
  services: ['srs', 'stream-uploader'],
  state: 'blocked',
  reason: 'stream-uploader of stage was never seen with a container created by attempt job-abc123.',
  startedAt: '2026-09-08T04:00:00.000Z',
  resolvedAt: '2026-09-08T04:05:00.000Z',
  releasedBy: null,
};

const OPEN: DeployAttemptView = {
  ...BLOCKED,
  id: 8,
  jobId: 'job-def456',
  state: 'open',
  reason: null,
  resolvedAt: null,
};

describe('attemptReleaseProblem', () => {
  it('asks for the job id when nothing was typed', () => {
    assert.match(String(attemptReleaseProblem('', BLOCKED)), /type the job id/i);
    assert.match(String(attemptReleaseProblem('   ', BLOCKED)), /type the job id/i);
  });

  it('refuses a job id that is not this attempt, naming the one it is', () => {
    const problem = attemptReleaseProblem('job-other', BLOCKED);
    assert.match(String(problem), /does not match/);
    assert.match(String(problem), /job-abc123/);
  });

  it('accepts the job id, with the spaces around it forgiven', () => {
    assert.equal(attemptReleaseProblem('job-abc123', BLOCKED), null);
    assert.equal(attemptReleaseProblem('  job-abc123 ', BLOCKED), null);
  });

  it('is exact otherwise: case and a partial id do not release', () => {
    assert.notEqual(attemptReleaseProblem('JOB-ABC123', BLOCKED), null);
    assert.notEqual(attemptReleaseProblem('job-abc', BLOCKED), null);
  });
});

describe('describeAttemptHold', () => {
  it('says a blocked attempt holds its deployment, and the daemon when its tags are shared', () => {
    const text = describeAttemptHold(BLOCKED);
    assert.match(text, /^Blocked\./);
    assert.match(text, /holds stage/);
    assert.match(text, /shared image tags/);
  });

  it('says a running attempt holds its deployment', () => {
    const text = describeAttemptHold(OPEN);
    assert.match(text, /^Running\./);
    assert.match(text, /holds stage/);
  });

  it('leaves the daemon out for an attempt whose images are its own', () => {
    const text = describeAttemptHold({ ...OPEN, kind: 'fixed' });
    assert.match(text, /holds stage/);
    assert.doesNotMatch(text, /shared image tags/);
  });

  it('says a released attempt holds nothing', () => {
    const text = describeAttemptHold({ ...BLOCKED, state: 'released', releasedBy: 'levi' });
    assert.match(text, /^Released/);
    assert.doesNotMatch(text, /holds/);
  });
});
