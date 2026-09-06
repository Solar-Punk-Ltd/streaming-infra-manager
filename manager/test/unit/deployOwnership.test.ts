/**
 * Who owns a deployment, and what a caller that does not own it may change.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A deploy claims the profile by moving it to DEPLOYING, and only the caller
 * holding that claim may write settings, write the env file, or mark the
 * profile ERROR. Before the claim existed, two concurrent PUTs on the same
 * RUNNING profile both passed the busy check, both rewrote the row and the env
 * file, and the one that lost the transition marked the profile ERROR while the
 * winner's deploy script was still running. ERROR is a redeployable status, so
 * a third request could then start a second deploy over the first.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GroupBusyError, ProfileBusyError } from '../../src/domain/errors/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

describe('updating one deployment', () => {
  it('lets one of two concurrent updates through and writes only its change', async () => {
    const harness = profileServiceHarness([
      makeProfile({ name: 'stage', notes: 'before' }),
    ]);

    // Both requests read the profile while it is still RUNNING, so both get
    // past the busy check and only the claim can separate them.
    const outcomes = await Promise.allSettled([
      harness.service.update('stage', { notes: 'winner' }),
      harness.service.update('stage', { notes: 'loser' }),
    ]);

    assert.equal(outcomes[0]!.status, 'fulfilled');
    assert.equal(outcomes[1]!.status, 'rejected');
    assert.ok(
      (outcomes[1] as PromiseRejectedResult).reason instanceof ProfileBusyError,
    );

    assert.deepEqual(harness.profiles.updateEditableCalls, ['stage']);
    assert.equal(harness.profiles.rows.get('stage')?.notes, 'winner');
    assert.deepEqual(harness.orchestrator.reserved, ['stage']);
  });

  it('leaves the winner deploying rather than letting the loser mark it ERROR', async () => {
    const harness = profileServiceHarness([
      makeProfile({ name: 'stage', notes: 'before' }),
    ]);

    await Promise.allSettled([
      harness.service.update('stage', { notes: 'winner' }),
      harness.service.update('stage', { notes: 'loser' }),
    ]);

    assert.equal(harness.profiles.statusOf('stage'), 'DEPLOYING');
    assert.deepEqual(harness.profiles.markErrorCalls, []);
  });

  it('marks a deploy that will not start ERROR exactly once', async () => {
    const harness = profileServiceHarness([makeProfile({ name: 'stage' })]);
    harness.orchestrator.failingDeploys.add('stage');

    await assert.rejects(
      harness.service.update('stage', { notes: 'after' }),
      /deploy could not start/,
    );

    // The orchestrator owns the claim, so it is the only thing that marks it.
    assert.deepEqual(harness.profiles.markErrorCalls, ['stage']);
    assert.equal(harness.profiles.statusOf('stage'), 'ERROR');
  });

  it('gives the claim back when the settings write fails', async () => {
    const harness = profileServiceHarness([
      makeProfile({ name: 'stage', notes: 'before' }),
    ]);
    harness.profiles.writesRefused.add('stage');

    await assert.rejects(
      harness.service.update('stage', { notes: 'after' }),
      /write refused/,
    );

    assert.deepEqual(harness.orchestrator.cancelled, ['stage']);
    assert.equal(harness.profiles.statusOf('stage'), 'RUNNING');
    assert.equal(harness.profiles.rows.get('stage')?.notes, 'before');
    assert.deepEqual(harness.orchestrator.deploys, []);
  });
});

describe('updating a group', () => {
  const groupOf = (names: readonly string[]) =>
    profileServiceHarness(
      names.map((name, index) =>
        makeProfile({ name, group_id: 1, port_slot: index + 1, notes: 'before' }),
      ),
    );

  const withGroup = (names: readonly string[]) => {
    const harness = groupOf(names);
    harness.groups.groups.push({
      id: 1,
      name: 'pool',
      size: names.length,
      kind: 'standard',
      created_at: new Date(0),
    });
    return harness;
  };

  it('changes no member when one of them cannot be claimed', async () => {
    const harness = withGroup(['pool-1', 'pool-2', 'pool-3']);
    harness.profiles.claimsRefused.add('pool-2');

    await assert.rejects(
      harness.service.updateGroupConfig(1, { notes: 'after' }),
      GroupBusyError,
    );

    assert.deepEqual(harness.groups.configWrites, []);
    assert.deepEqual(harness.profiles.updateEditableCalls, []);
    assert.deepEqual(harness.orchestrator.deploys, []);
    for (const name of ['pool-1', 'pool-2', 'pool-3']) {
      assert.equal(harness.profiles.rows.get(name)?.notes, 'before');
    }
  });

  it('gives back the claims it had already taken', async () => {
    const harness = withGroup(['pool-1', 'pool-2', 'pool-3']);
    harness.profiles.claimsRefused.add('pool-3');

    await assert.rejects(
      harness.service.updateGroupConfig(1, { notes: 'after' }),
      GroupBusyError,
    );

    assert.deepEqual(harness.orchestrator.cancelled, ['pool-1', 'pool-2']);
    assert.equal(harness.profiles.statusOf('pool-1'), 'RUNNING');
    assert.equal(harness.profiles.statusOf('pool-2'), 'RUNNING');
  });

  it('deploys every member once all of them are claimed', async () => {
    const harness = withGroup(['pool-1', 'pool-2']);

    const { profiles } = await harness.service.updateGroupConfig(1, {
      notes: 'after',
    });

    assert.deepEqual(harness.orchestrator.reserved, ['pool-1', 'pool-2']);
    assert.deepEqual(
      harness.orchestrator.deploys.map((deploy) => deploy.profileName),
      ['pool-1', 'pool-2'],
    );
    assert.deepEqual(
      profiles.map((profile) => profile.notes),
      ['after', 'after'],
    );
  });

  it('carries on past a member whose deploy will not start', async () => {
    const harness = withGroup(['pool-1', 'pool-2']);
    harness.orchestrator.failingDeploys.add('pool-1');

    const { profiles } = await harness.service.updateGroupConfig(1, {
      notes: 'after',
    });

    assert.deepEqual(
      profiles.map((profile) => profile.status),
      ['ERROR', 'DEPLOYING'],
    );
    // Marked by the orchestrator, which holds the claim, and only by it.
    assert.deepEqual(harness.profiles.markErrorCalls, ['pool-1']);
  });
});

describe('creating and growing a group', () => {
  // A single deployment made through the same wizard is deployed on creation.
  // A group used to be inserted STOPPED and left there under a "Deploying"
  // toast, so the members had to be started one by one by hand.
  it('deploys every member it creates', async () => {
    const harness = profileServiceHarness();

    const { profiles } = await harness.service.createGroup({
      group_name: 'pool',
      size: 3,
      kind: 'viewer',
    });

    assert.deepEqual(harness.orchestrator.reserved, [
      'pool-profile-1',
      'pool-profile-2',
      'pool-profile-3',
    ]);
    assert.deepEqual(
      profiles.map((profile) => profile.status),
      ['DEPLOYING', 'DEPLOYING', 'DEPLOYING'],
    );
  });

  it('reports the member whose deploy did not start, and deploys the rest', async () => {
    const harness = profileServiceHarness();
    harness.orchestrator.failingDeploys.add('pool-profile-2');

    const { profiles } = await harness.service.createGroup({
      group_name: 'pool',
      size: 3,
      kind: 'viewer',
    });

    assert.deepEqual(
      profiles.map((profile) => profile.status),
      ['DEPLOYING', 'ERROR', 'DEPLOYING'],
    );
    assert.match(profiles[1]!.last_error ?? '', /deploy could not start/);
  });

  it('deploys the members a resize adds', async () => {
    const harness = profileServiceHarness();
    const { group } = await harness.service.createGroup({
      group_name: 'pool',
      size: 1,
      kind: 'viewer',
    });

    const { profiles } = await harness.service.addGroupMembers(group.id, 2);

    assert.deepEqual(
      profiles.map((profile) => profile.name),
      ['pool-profile-2', 'pool-profile-3'],
    );
    assert.deepEqual(
      profiles.map((profile) => profile.status),
      ['DEPLOYING', 'DEPLOYING'],
    );
  });
});
