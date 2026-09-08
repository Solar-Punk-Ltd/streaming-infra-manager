import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookRecoveryObservation } from '@streaming-infra-manager/common';
import { attributionConflictObservation, normalizeRecoveryObservation, recoveryHashes } from '../../src/domain/chequebook/recoveryObservation.js';
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
  it('keeps a full observation bounded and labels direct evidence retained in the response journal', async () => {
    const repository = new InMemoryChequebookOperations();
    const { operation } = await repository.admit(operationCandidate());
    const candidateHashes = hashes(256);
    const full = { ...operation, recoveryObservation: { kind: 'ambiguous' as const, candidateHashes } };
    const directHash = `0x${'ff'.repeat(32)}`;
    const conflict = attributionConflictObservation(full, directHash);
    assert.equal(conflict.kind, 'could_not_check');
    assert.deepEqual(conflict.candidateHashes, candidateHashes);
    assert.equal(conflict.additionalEvidenceInResponseJournal, true);
    assert.deepEqual(normalizeRecoveryObservation(conflict), conflict);
    const repeated = attributionConflictObservation({ ...full, recoveryObservation: conflict }, candidateHashes[0]!);
    assert.equal(repeated.additionalEvidenceInResponseJournal, true);
    assert.deepEqual(repeated.candidateHashes, candidateHashes);
  });

  it('includes uncapped direct hashes and rejects misleading overflow markers', async () => {
    const repository = new InMemoryChequebookOperations();
    const { operation } = await repository.admit(operationCandidate());
    const [owned, response] = hashes(2);
    const conflict = attributionConflictObservation({ ...operation, transactionHash: owned! }, response!);
    assert.deepEqual(conflict.candidateHashes, [owned, response]);
    assert.equal(conflict.additionalEvidenceInResponseJournal, undefined);
    assert.throws(() => normalizeRecoveryObservation({ kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [], additionalEvidenceInResponseJournal: true } as unknown as ChequebookRecoveryObservation), /invalid/i);
  });

});
