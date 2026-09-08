import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookRecoveryObservation } from '@streaming-infra-manager/common';
import { recoveryHashes } from '../../src/domain/chequebook/recoveryObservation.js';
import { InMemoryChequebookOperations, operationCandidate } from '../support/chequebookOperations.js';

const hashes = (count: number) => Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`);

describe('recovery evidence limits', () => {
  it('applies the cap to validated unique hashes, including case-insensitive duplicates', () => {
    const candidates = hashes(256);
    assert.deepEqual(recoveryHashes([...candidates, ...candidates.map(hash => `0x${hash.slice(2).toUpperCase()}`)]), candidates);
    assert.throws(() => recoveryHashes([...candidates, 'not-a-hash']), /invalid/i);
    assert.throws(() => recoveryHashes(hashes(257)), /invalid/i);
  });

  it('advances a persisted cursor with the same 129 candidate hashes on the next chunk', async () => {
    const repository = new InMemoryChequebookOperations();
    const admitted = await repository.admit(operationCandidate());
    const candidateHashes = hashes(129);
    const firstObservation: ChequebookRecoveryObservation = { kind: 'searching', candidateHashes,
      scan: { headBlockNumber: '505', headBlockHash: hashes(505)[504]!, nextBlockNumber: '503', nextBlockHash: hashes(503)[502]!, complete: false, candidateHashes } };
    const first = await repository.recordRecovery(admitted.operation, firstObservation, []);
    const nextObservation: ChequebookRecoveryObservation = { ...firstObservation,
      scan: { ...firstObservation.scan, nextBlockNumber: '501', nextBlockHash: hashes(501)[500]! } };
    const next = await repository.recordRecovery(first, nextObservation, []);
    assert.equal(next.revision, String(BigInt(first.revision) + 1n));
    assert.equal(next.recoveryObservation?.scan?.nextBlockNumber, '501');
    assert.deepEqual(next.recoveryObservation?.candidateHashes, candidateHashes);
    assert.deepEqual((await repository.findById(next.id))?.recoveryObservation, nextObservation);
  });
});
