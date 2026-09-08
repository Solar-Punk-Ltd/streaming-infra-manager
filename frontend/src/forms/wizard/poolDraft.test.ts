import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABR_LADDER_SIZE, ABR_NODE_POOL_GROUP_KIND, ladderMemberNames } from '@streaming-infra-manager/common';
import type { DeploymentGroup, Profile } from '../../types';
import { beginPoolSetup, finishPoolSetup, overlayCreatedPool } from './poolDraft';
import { initialWizardState, type WizardContext } from './wizardState';

const context: WizardContext = { profiles: [], groups: [], serverHost: 'fixture.test', hostPassphrase: null, poolResults: new Map(), versions: [] };
const uploader = {
  ...initialWizardState({ goal: 'abr-uploader' }, context),
  step: 3, name: 'test-uploader', host: 'custom' as const, hostCustom: 'fixture-host',
  notes: 'uploader-only note', versionId: 7, keyMode: 'paste' as const,
  pastedKey: 'synthetic-uploader-key', ownPassphrase: 'synthetic-uploader-passphrase',
  passMode: 'custom' as const, poolString: 'retained-external-choice',
};
const group: DeploymentGroup = { id: 79, name: 'chosen-pool', size: ABR_LADDER_SIZE, kind: ABR_NODE_POOL_GROUP_KIND, created_at: '2026-09-08T00:00:00Z' };
const profiles = ladderMemberNames(group.name).map(name => ({ name, group_id: group.id, components: ['bee-uploader'] } as Profile));

describe('uploader draft round trip through pool creation', () => {
  it('starts an independent pool form with only the intended host and version carried over', () => {
    const setup = beginPoolSetup(uploader, context);
    assert.deepEqual(setup.uploader, uploader);
    assert.equal(setup.pool.goal, 'abr-pool');
    assert.equal(setup.pool.step, 2);
    assert.equal(setup.pool.hostCustom, uploader.hostCustom);
    assert.equal(setup.pool.versionId, 7);
    assert.equal(setup.pool.name, '');
    assert.equal(setup.pool.notes, '');
    assert.equal(setup.pool.pastedKey, '');
    assert.equal(setup.pool.ownPassphrase, '');
    setup.pool.components.push('fixture-change');
    assert.deepEqual(setup.uploader.components, uploader.components);
  });

  it('restores cancellation unchanged and selects only the exact successful compatible pool id', () => {
    assert.deepEqual(finishPoolSetup(uploader, null).state, uploader);
    const result = finishPoolSetup(uploader, { expectedName: group.name, group, profiles });
    assert.equal(result.state.poolId, group.id);
    assert.equal(result.state.poolMode, 'pick');
    assert.equal(result.state.step, 3);
    assert.equal(result.state.name, uploader.name);
    assert.equal(result.state.pastedKey, uploader.pastedKey);
    assert.equal(result.state.ownPassphrase, uploader.ownPassphrase);
    assert.equal(result.created?.group.id, group.id);
  });

  it('retains the draft without selection for unrelated, duplicate or incomplete member results', () => {
    const badResults = [
      { group: { ...group, kind: 'standard' }, profiles },
      { group: { ...group, name: 'different-pool' }, profiles },
      { group, profiles: profiles.slice(1) },
      { group, profiles: [profiles[0], ...profiles.slice(0, -1)] },
      { group, profiles: profiles.map(profile => ({ ...profile, group_id: 80 })) },
    ];
    for (const result of badResults) {
      const restored = finishPoolSetup(uploader, { expectedName: group.name, ...result });
      assert.deepEqual(restored.state, uploader);
      assert.equal(restored.created, null);
      assert.match(restored.notice ?? '', /could not select/i);
    }
  });

  it('keeps the exact returned identity while the global list is delayed without replacing fresher members', () => {
    const created = { group, profiles };
    const overlay = overlayCreatedPool([], [], created);
    assert.equal(overlay.groups[0].id, 79);
    assert.equal(overlay.profiles.length, ABR_LADDER_SIZE);
    const fresh = { ...profiles[0], status: 'RUNNING' as const };
    assert.equal(overlayCreatedPool([group], [fresh], created).profiles.find(profile => profile.name === fresh.name)?.status, 'RUNNING');
    const unrelated = { ...group, id: 88, name: 'other-pool' };
    assert.deepEqual(overlayCreatedPool([unrelated], [], created).groups.map(pool => pool.id), [88, 79]);
  });
});
