import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MANAGER_SLOT_CAP, PORT_SLOT_STRIDE, portExposureProblem, publicPortRole } from './portPolicy.js';

describe('shared port exposure policy', () => {
  it('shares the decided manager ceiling and stack stride', () => {
    assert.equal(MANAGER_SLOT_CAP, 100);
    assert.equal(PORT_SLOT_STRIDE, 10);
  });

  it('accepts a known rung peer while refusing RTMP or an unknown owner on its public tuple', () => {
    const peer = { port: 11012, protocol: 'tcp', portVar: 'BEE_RUNG_480P_P2P_PORT', service: 'bee-uploader-480p' };
    assert.equal(portExposureProblem(peer), null);
    assert.equal(publicPortRole(peer)?.group, 'rung_p2p');
    assert.match(portExposureProblem({ ...peer, portVar: 'SRS_RTMP_PORT', service: 'srs' })!, /11012.*public/);
    assert.match(portExposureProblem({ ...peer, service: null })!, /11012.*public/);
  });

  it('keeps TCP and UDP permissions distinct', () => {
    assert.equal(portExposureProblem({ port: 10011, protocol: 'tcp', portVar: 'API_PORT', service: 'stream-uploader' }), null);
    assert.match(portExposureProblem({ port: 10011, protocol: 'udp', portVar: 'API_PORT', service: 'stream-uploader' })!, /public/);
  });

  it('refuses endpoints outside the firewall protected range', () => {
    for (const port of [9999, 20000, 65536, NaN]) {
      assert.ok(portExposureProblem({ port, protocol: 'tcp', portVar: 'API_PORT', service: 'stream-uploader' }));
    }
    for (const port of [10000, 19999]) {
      assert.equal(portExposureProblem({ port, protocol: 'tcp', portVar: 'API_PORT', service: 'stream-uploader' }), null);
    }
  });
});
