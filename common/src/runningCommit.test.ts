/**
 * What a deployment page says runs, from what each container was seen to
 * be started from. `pnpm test` in common/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runningCommitOf } from './runningCommit.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('runningCommitOf', () => {
  it('is one commit when every container agrees', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: A },
        { service: 'stream-uploader', buildCommit: A },
      ]),
      { kind: 'one', commit: A },
    );
  });

  it('is mixed, naming each service, when they do not', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: B },
        { service: 'stream-uploader', buildCommit: A },
      ]),
      { kind: 'mixed', byService: [{ service: 'srs', commit: B }, { service: 'stream-uploader', commit: A }] },
    );
  });

  it('is unknown when nothing was observed, or a container carries no commit', () => {
    assert.deepEqual(runningCommitOf([]), { kind: 'unknown' });
    assert.deepEqual(runningCommitOf([{ service: 'srs', buildCommit: null }]), { kind: 'unknown' });
  });

  it('counts a container without a commit as unknown beside known ones, not as agreement', () => {
    assert.deepEqual(
      runningCommitOf([
        { service: 'srs', buildCommit: A },
        { service: 'bee-uploader', buildCommit: null },
      ]),
      { kind: 'mixed', byService: [{ service: 'srs', commit: A }, { service: 'bee-uploader', commit: null }] },
    );
  });
});
