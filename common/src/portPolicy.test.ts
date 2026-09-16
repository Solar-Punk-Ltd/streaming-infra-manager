import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MANAGER_SLOT_CAP, PORT_SLOT_STRIDE, portExposureProblem, publicPortRole } from './portPolicy.js';

describe('shared port exposure policy', () => {
  it('shares the decided manager ceiling and stack stride', () => {
    assert.equal(MANAGER_SLOT_CAP, 100);
    assert.equal(PORT_SLOT_STRIDE, 10);
  });

  it('accepts a known Bee peer while refusing RTMP or an unknown owner on its public tuple', () => {
    const peer = { port: 10016, protocol: 'tcp', portVar: 'BEE_UPLOADER_P2P_PORT', service: 'bee-uploader' };
    assert.equal(portExposureProblem(peer), null);
    assert.equal(publicPortRole(peer)?.group, 'bee_p2p');
    assert.match(portExposureProblem({ ...peer, portVar: 'SRS_RTMP_PORT', service: 'srs' })!, /10016.*public/);
    assert.match(portExposureProblem({ ...peer, service: null })!, /10016.*public/);
  });

  it('opens no band for the rung peers, whose services this manager never starts', () => {
    // Slot 1 of each of the three roles that used to be here. The generated
    // firewall opened 297 ports for bee-uploader-480p, -720p and -1080p, and
    // ALL_SERVICES has never carried any of them.
    for (const port of [11012, 11014, 11016]) {
      assert.equal(publicPortRole({ port, protocol: 'tcp' }), null);
    }
    // Still a legal endpoint. It is simply nobody's public tuple now, so any
    // owner may hold it and the reservation plan may go on reserving it.
    assert.equal(
      portExposureProblem({ port: 11012, protocol: 'tcp', portVar: 'SRS_RTMP_PORT', service: 'srs' }),
      null,
    );
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
