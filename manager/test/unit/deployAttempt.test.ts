/**
 * When an attempt to deploy is over, and what may run beside it.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Compose builds every service before it creates any container, and only
 * the attempt that holds the project's guard creates containers in that
 * project. So a container id that did not exist before the attempt started,
 * for every service the attempt touched, proves the build phase finished
 * before the manager died and no delayed export can follow. Anything less
 * proves nothing: an old id with a later timestamp is a restart or a clock,
 * and an attempt whose recreate changed nothing leaves the same ids. Those
 * stay blocked until a person who checked the host releases them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type DeployAttempt,
  attemptOutcome,
  whyAdmissionIsRefused,
} from '../../src/domain/deployAttempts.js';

const OPEN: DeployAttempt = {
  target: null,
  id: 7,
  daemonId: 'daemon-1',
  project: 'stage',
  jobId: 'job-a',
  kind: 'shared',
  services: ['srs', 'stream-uploader'],
  preJobContainerIds: ['c-srs-old', 'c-up-old'],
  state: 'open',
  reason: null,
  startedAt: new Date(0),
  resolvedAt: null,
  releasedBy: null,
};

describe('attemptOutcome', () => {
  it('releases when every touched service has a container the attempt did not start with', () => {
    const outcome = attemptOutcome(OPEN, new Map([
      ['srs', ['c-srs-new']],
      ['stream-uploader', ['c-up-new']],
    ]));

    assert.deepEqual(outcome, { state: 'released', reason: null });
  });

  it('stays blocked while one touched service still shows only ids from before', () => {
    const outcome = attemptOutcome(OPEN, new Map([
      ['srs', ['c-srs-new']],
      ['stream-uploader', ['c-up-old']],
    ]));

    assert.equal(outcome.state, 'blocked');
    assert.match(outcome.reason ?? '', /stream-uploader/);
    assert.match(outcome.reason ?? '', /job-a/);
  });

  it('stays blocked when a touched service has no container at all', () => {
    const outcome = attemptOutcome(OPEN, new Map([['srs', ['c-srs-new']]]));

    assert.equal(outcome.state, 'blocked');
    assert.match(outcome.reason ?? '', /stream-uploader/);
  });

  it('does not count an old id as new because it was seen again, whatever its timestamps say', () => {
    const outcome = attemptOutcome(OPEN, new Map([
      ['srs', ['c-srs-old']],
      ['stream-uploader', ['c-up-old']],
    ]));

    assert.equal(outcome.state, 'blocked');
  });

  it('counts a new id beside an old one, which is what a recreate leaves for a moment', () => {
    const outcome = attemptOutcome(OPEN, new Map([
      ['srs', ['c-srs-old', 'c-srs-new']],
      ['stream-uploader', ['c-up-new']],
    ]));

    assert.equal(outcome.state, 'released');
  });
});

describe('whyAdmissionIsRefused', () => {
  const blockedOnStage: DeployAttempt = { ...OPEN, state: 'blocked', reason: 'stream-uploader was never seen with a new container' };
  const openOnOther: DeployAttempt = { ...OPEN, id: 8, project: 'other', jobId: 'job-b' };
  const fixedOnOther: DeployAttempt = { ...openOnOther, kind: 'fixed' };

  it('refuses the same project while any attempt on it is unresolved, whatever the tags', () => {
    for (const holder of [OPEN, blockedOnStage, { ...blockedOnStage, kind: 'fixed' as const }]) {
      const why = whyAdmissionIsRefused({ daemonId: 'daemon-1', project: 'stage', kind: 'fixed' }, [holder]);
      assert.match(why ?? '', /stage/);
      assert.match(why ?? '', /job-a/);
    }
  });

  it('refuses a shared-tag job while another shared-tag job holds the daemon, naming it', () => {
    const why = whyAdmissionIsRefused({ daemonId: 'daemon-1', project: 'stage', kind: 'shared' }, [openOnOther]);

    assert.match(why ?? '', /other/);
    assert.match(why ?? '', /job-b/);
  });

  it('lets a fixed-image job of another project run beside anything', () => {
    assert.equal(whyAdmissionIsRefused({ daemonId: 'daemon-1', project: 'stage', kind: 'fixed' }, [openOnOther, fixedOnOther]), null);
  });

  it('lets a shared-tag job run beside a fixed-image job of another project', () => {
    assert.equal(whyAdmissionIsRefused({ daemonId: 'daemon-1', project: 'stage', kind: 'shared' }, [fixedOnOther]), null);
  });

  it('says a running attempt resolves on its own and a blocked one waits for a person', () => {
    const request = { daemonId: 'daemon-1', project: 'stage', kind: 'shared' as const };

    const running = whyAdmissionIsRefused(request, [OPEN]) ?? '';
    assert.match(running, /still running/);
    assert.match(running, /on its own/);

    const blocked = whyAdmissionIsRefused(request, [blockedOnStage]) ?? '';
    assert.match(blocked, /blocked/);
    assert.match(blocked, /stream-uploader/);
    assert.doesNotMatch(blocked, /on its own/, 'a judged attempt is never judged again');
    assert.match(blocked, /release/);
  });

  it('ignores attempts on another daemon and attempts already released', () => {
    const elsewhere = { ...OPEN, daemonId: 'daemon-2' };
    const released = { ...OPEN, state: 'released' as const, resolvedAt: new Date(1) };

    assert.equal(whyAdmissionIsRefused({ daemonId: 'daemon-1', project: 'stage', kind: 'shared' }, [elsewhere, released]), null);
  });
});
