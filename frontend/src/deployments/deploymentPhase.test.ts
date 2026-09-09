import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deploymentProgressText } from './deploymentPhase';
import { statusLabelOf } from './shape';
import type { Profile } from '../types';

const deploying = { status: 'DEPLOYING', containers: [{ service: 'srs', ports: {} }] } as Profile;

describe('deployment phase evidence', () => {
  it('distinguishes manager-recorded starting and restarting across a reload', () => {
    for (const phase of ['starting', 'restarting'] as const) {
      const profile = JSON.parse(JSON.stringify({ ...deploying, deployment_phase: phase }));
      assert.equal(statusLabelOf(profile).label.toLowerCase(), phase);
      assert.match(deploymentProgressText(profile), new RegExp(phase, 'i'));
      assert.doesNotMatch(deploymentProgressText(profile), /stopped|ingest is up/i);
    }
  });

  it('does not guess the phase from retained container records', () => {
    assert.equal(statusLabelOf(deploying).label, 'Deploying');
    assert.match(deploymentProgressText(deploying), /not yet verified/i);
  });

  it('does not report stopping, removing, or failed deployments as stopped', () => {
    for (const status of ['STOPPING', 'REMOVING', 'ERROR'] as const) {
      assert.doesNotMatch(deploymentProgressText({ ...deploying, status }), /deployment is stopped/i);
    }
  });
});
