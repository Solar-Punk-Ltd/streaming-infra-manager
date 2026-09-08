/**
 * The ports a deployment binds for its slot, as the reservation table
 * records them.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/. The plan is
 * the version's port table shifted by ten per slot, each port with the
 * protocol its compose file publishes it on and the service that publishes
 * it, so a reservation is a physical thing: one transport, one port number,
 * one daemon.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StackPortVar } from '@streaming-infra-manager/common';

import { portKeyOf, portPlanFor } from '../../src/domain/ports/portReservations.js';

const TABLE: StackPortVar[] = [
  { name: 'API_PORT', defaultPort: 3000, slotBase: 10000, protocol: 'tcp', service: 'stream-uploader' },
  { name: 'SRS_SRT_PORT', defaultPort: 10080, slotBase: 10001, protocol: 'udp', service: 'srs' },
  { name: 'BEE_RUNG_480P_P2P_PORT', defaultPort: 11002, slotBase: 11002, protocol: 'tcp', service: null },
];

describe('portPlanFor', () => {
  it('shifts every port of the table by ten per slot and keeps its protocol and service', () => {
    assert.deepEqual(portPlanFor(TABLE, 3), [
      { protocol: 'tcp', port: 10030, portVar: 'API_PORT', service: 'stream-uploader' },
      { protocol: 'udp', port: 10031, portVar: 'SRS_SRT_PORT', service: 'srs' },
      { protocol: 'tcp', port: 11032, portVar: 'BEE_RUNG_480P_P2P_PORT', service: null },
    ]);
  });

  it('is the default ports for slot 0, where the env file decides', () => {
    assert.deepEqual(portPlanFor(TABLE, 0).map((entry) => entry.port), [3000, 10080, 11002]);
  });

  it('names an entry by transport and port, the pair a daemon owns once', () => {
    assert.equal(portKeyOf({ protocol: 'udp', port: 10031 }), 'udp/10031');
  });
});
