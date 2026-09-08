import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesChequebookTransfer, tokenAddressForChain } from '../../src/domain/chequebook/transactionIdentity.js';
import { parseChainTransaction, parseChainReceipt } from '../../src/domain/chequebook/chainEvidence.js';
import { operationCandidate, transactionHash } from '../support/chequebookOperations.js';

const gnosisToken = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const candidate = operationCandidate({ tokenAddress: gnosisToken });
const depositData = `0xa9059cbb${'0'.repeat(24)}${candidate.chequebookAddress.slice(2)}${'11c37937e08000'.padStart(64, '0')}`;
const withdrawalData = `0x2e1a7d4d${'11c37937e08000'.padStart(64, '0')}`;
const blockHash = `0x${'77'.repeat(32)}`;

function rawTransaction(overrides: Record<string, unknown> = {}) {
  return { hash: transactionHash, chainId: '0x64', type: '0x2', from: candidate.nodeAddress, to: gnosisToken, input: depositData, nonce: '0x8', value: '0x0', blockNumber: '0x1f5', blockHash, ...overrides };
}

describe('versioned chequebook transaction identity', () => {
  it('uses documented token addresses and refuses an unknown chain', () => {
    assert.equal(tokenAddressForChain(100), gnosisToken);
    assert.equal(tokenAddressForChain(1), '0x19062190b1925b5b6689d7073fdfc8c2976ef8cb');
    assert.equal(tokenAddressForChain(11155111), '0x543ddb01ba47acb11de34891cd86b675f04840db');
    assert.equal(tokenAddressForChain(9999), null);
  });

  it('matches the verified Bee 2.8.2 deposit and withdrawal ABI vectors', () => {
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction())), true);
    const withdrawal = parseChainTransaction(rawTransaction({ to: candidate.chequebookAddress, input: withdrawalData }));
    assert.equal(matchesChequebookTransfer({ ...candidate, direction: 'withdraw' }, withdrawal), true);
    assert.equal(matchesChequebookTransfer(candidate, withdrawal), false);
  });

  it('accepts the intended transfer at n+1 without adopting an unrelated transfer at n', () => {
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ input: withdrawalData }))), false);
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ nonce: '0x9' }))), true);
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ nonce: '0x7' }))), false);
  });

  it('matches pending evidence without declaring settlement', () => {
    const pending = parseChainTransaction(rawTransaction({ blockNumber: null, blockHash: null }));
    assert.equal(matchesChequebookTransfer(candidate, pending), true);
    assert.equal(pending.blockNumber, null);
    assert.equal(parseChainReceipt(null), null);
  });

  it('refuses the wrong sender, chain, destination, recipient, amount or native value', () => {
    const other = `0x${'99'.repeat(20)}`;
    const badData = [
      `0xa9059cbb${'0'.repeat(24)}${other.slice(2)}${'11c37937e08000'.padStart(64, '0')}`,
      `${depositData.slice(0, -1)}1`,
      `0x095ea7b3${depositData.slice(10)}`,
      `${depositData}00`,
      `0xa9059cbb${'f'.repeat(24)}${depositData.slice(34)}`,
    ];
    const changes = [{ from: other }, { chainId: '0x1' }, { to: other }, { to: null }, { value: '0x1' }, ...badData.map(input => ({ input }))];
    for (const change of changes) assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction(change))), false, JSON.stringify(change));
    assert.equal(matchesChequebookTransfer({ ...candidate, tokenAddress: other }, parseChainTransaction(rawTransaction())), false);
    assert.equal(matchesChequebookTransfer({ ...candidate, chainId: 9999 }, parseChainTransaction(rawTransaction({ chainId: '0x270f' }))), false);
  });

  it('refuses evidence mined before the frozen block or on a conflicting start block', () => {
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ blockNumber: '0x1f3' }))), false);
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ blockNumber: '0x1f4' }))), false);
    assert.equal(matchesChequebookTransfer(candidate, parseChainTransaction(rawTransaction({ blockNumber: '0x1f4', blockHash: candidate.startBlockHash }))), true);
  });

  it('normalizes quantities without losing precision and derives protected legacy chain ids', () => {
    const huge = '9007199254740993';
    const parsed = parseChainTransaction(rawTransaction({ nonce: `0x${BigInt(huge).toString(16)}`, type: '0x0', chainId: undefined, v: '0xeb' }));
    assert.equal(parsed.nonce, huge);
    assert.equal(parsed.chainId, 100);
    assert.equal(parsed.value, '0');
    assert.equal(parsed.data, depositData);
  });

  it('refuses malformed or contradictory RPC evidence without copying its contents', () => {
    for (const changes of [
      { hash: 'sensitive malformed value' }, { from: '' }, { input: '0x1' }, { nonce: '0x00' },
      { chainId: undefined, v: '0x1b', type: '0x0' }, { chainId: '0x64', v: '0x25', type: '0x0' },
      { chainId: undefined, v: '0xeb', type: '0x2' }, { blockHash: null }, { blockNumber: null },
    ]) {
      assert.throws(() => parseChainTransaction(rawTransaction(changes)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'ChainEvidenceError');
        assert.ok(!error.message.includes('sensitive'));
        return true;
      });
    }
  });

  it('distinguishes successful, reverted, absent and malformed receipts', () => {
    const receipt = { transactionHash, blockHash, blockNumber: '0x1f5', from: candidate.nodeAddress, to: gnosisToken, status: '0x1' };
    assert.equal(parseChainReceipt(receipt)?.status, 'success');
    assert.equal(parseChainReceipt({ ...receipt, status: '0x0' })?.status, 'reverted');
    assert.equal(parseChainReceipt(null), null);
    for (const changes of [{ status: '0x2' }, { status: null }, { blockHash: null }, { transactionHash: '' }]) {
      assert.throws(() => parseChainReceipt({ ...receipt, ...changes }), /could not be verified/i);
    }
  });
});
