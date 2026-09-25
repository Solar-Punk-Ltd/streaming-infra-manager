/**
 * Which deployments the page asks how their SRT link is holding up.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../types';
import { readsSrtIngest } from './shape';

const srsStream = (status: Profile['status']): Profile =>
  ({
    status,
    components: ['srs', 'stream-uploader'],
    containers: [{ service: 'srs', ports: {} }],
  }) as unknown as Profile;

describe('whether the page reads the SRT ingest', () => {
  it('reads a running SRS deployment', () => {
    assert.equal(readsSrtIngest(srsStream('RUNNING')), true);
  });

  // The manager keeps a deployment's container records after it stops, so the
  // records alone would keep asking a stopped SRS every ten seconds.
  it('does not read a stopped or failed one, which keeps its container records', () => {
    for (const status of ['STOPPED', 'ERROR'] as const) {
      assert.equal(readsSrtIngest(srsStream(status)), false, status);
    }
  });

  it('does not read a deployment on another engine', () => {
    const ome = {
      status: 'RUNNING',
      components: ['ome', 'stream-uploader'],
      containers: [{ service: 'ome', ports: {} }],
    } as unknown as Profile;

    assert.equal(readsSrtIngest(ome), false);
  });
});
