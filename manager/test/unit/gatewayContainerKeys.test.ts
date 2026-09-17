/**
 * The env keys the snapshot records against a Bee gateway container.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The snapshot is what a page shows as a container's environment, so a key
 * listed here is a claim that the container reads it. The gateway's has carried
 * RPC_ENDPOINT since it was written, and the stack's compose gives that service
 * an empty endpoint literal and never interpolates the variable, so the claim
 * was wrong before T27 and is wrong in a new way after it: a gateway on the
 * chain reads its endpoint from a key of its own.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import {
  buildContainerSnapshot,
  SERVICE_ENV_KEYS,
} from '../../src/domain/containerKeysSpec.js';

const gatewayKeys = () => SERVICE_ENV_KEYS[BEE_GATEWAY_SERVICE] ?? [];

describe('the keys a Bee gateway is recorded against', () => {
  it('names the two a gateway on the chain reads', () => {
    assert.ok(gatewayKeys().includes('BEE_GATEWAY_RPC_ENDPOINT'));
    assert.ok(gatewayKeys().includes('BEE_GATEWAY_SWAP_ENABLE'));
  });

  it('no longer claims the gateway reads RPC_ENDPOINT', () => {
    assert.equal(gatewayKeys().includes('RPC_ENDPOINT'), false);
  });

  it('leaves RPC_ENDPOINT where a node does read it', () => {
    assert.ok((SERVICE_ENV_KEYS[BEE_UPLOADER_SERVICE] ?? []).includes('RPC_ENDPOINT'));
  });

  it('records what a light gateway was started with, and nothing it ignores', () => {
    const snapshot = buildContainerSnapshot(BEE_GATEWAY_SERVICE, {
      BEE_GATEWAY_RPC_ENDPOINT: 'https://rpc.example.org',
      BEE_GATEWAY_SWAP_ENABLE: 'true',
      RPC_ENDPOINT: 'https://rpc.example.org',
    });

    assert.deepEqual(snapshot.env, {
      BEE_GATEWAY_RPC_ENDPOINT: 'https://rpc.example.org',
      BEE_GATEWAY_SWAP_ENABLE: 'true',
    });
  });
});
