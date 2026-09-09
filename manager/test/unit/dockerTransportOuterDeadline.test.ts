import assert from 'node:assert/strict';
import { it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { acquireLocalDockerBeeStream } from '../../src/domain/chequebook/acquireLocalDockerBeeStream.js';
import { beginSshDockerBeeAcquisition } from '../../src/domain/chequebook/sshDockerBeeAcquisition.js';
import { fakeForwardHarness, forwardLimits, remoteLocator } from '../support/sshForwardLifecycle.js';
import { syntheticTarget } from '../support/syntheticDockerBee.js';

for (const cap of ['expired', 'not-finite'] as const) {
  it(`refuses ${cap} outer deadline before local resolution or connection`, async () => {
    let resolutions = 0; let connections = 0;
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => { resolutions++; throw new Error('No resolver expected'); },
      {}, () => true, undefined, () => { connections++; throw new Error('No connect expected'); }, cap === 'expired' ? performance.now() - 1 : NaN));
    assert.equal(resolutions, 0); assert.equal(connections, 0);
  });

  it(`refuses ${cap} outer deadline before remote resolution or owned resource creation`, async () => {
    const h = fakeForwardHarness(); let resolutions = 0;
    const acquisition = beginSshDockerBeeAcquisition(syntheticTarget, async () => { resolutions++; return remoteLocator(); },
      forwardLimits, h.dependencies, () => true, undefined, cap === 'expired' ? -1 : NaN);
    const result = await acquisition.result.then(() => 'acquired', () => 'refused');
    acquisition.dispose(); await acquisition.cleanup;
    assert.equal(result, 'refused'); assert.equal(resolutions, 0); assert.equal(h.events.includes('mkdir'), false);
  });
}
