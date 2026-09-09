import type { ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import type { ChainTransaction } from './chainEvidence.js';

// Source and pinned Bee ABI evidence: docs/testing/t09-transaction-contracts.md.
const TOKEN_ADDRESSES: Readonly<Record<number, string>> = Object.freeze({
  1: '0x19062190b1925b5b6689d7073fdfc8c2976ef8cb',
  100: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da',
  11155111: '0x543ddb01ba47acb11de34891cd86b675f04840db',
});
const ERC20_TRANSFER_SELECTOR = 'a9059cbb';
const CHEQUEBOOK_WITHDRAW_SELECTOR = '2e1a7d4d';
type TransferIdentity = ChequebookTransferContext & Pick<ChequebookTransferIntent, 'direction' | 'amountPlur'>;

export function tokenAddressForChain(chainId: number): string | null {
  return TOKEN_ADDRESSES[chainId] ?? null;
}

/** Identity only. A matching pending transaction is not evidence of settlement. */
export function matchesChequebookTransfer(operation: TransferIdentity, transaction: ChainTransaction): boolean {
  const token = tokenAddressForChain(operation.chainId);
  if (!token || token !== operation.tokenAddress || transaction.chainId !== operation.chainId) return false;
  if (transaction.from !== operation.nodeAddress || transaction.value !== '0') return false;
  if (BigInt(transaction.nonce) < BigInt(operation.nonceLowerBound)) return false;
  if (transaction.blockNumber !== null) {
    if (BigInt(transaction.blockNumber) < BigInt(operation.startBlockNumber)) return false;
    if (transaction.blockNumber === operation.startBlockNumber && transaction.blockHash !== operation.startBlockHash) return false;
  }
  const amountWord = BigInt(operation.amountPlur).toString(16).padStart(64, '0');
  if (operation.direction === 'deposit') {
    const recipientWord = operation.chequebookAddress.slice(2).padStart(64, '0');
    return transaction.to === token && transaction.data === `0x${ERC20_TRANSFER_SELECTOR}${recipientWord}${amountWord}`;
  }
  return operation.direction === 'withdraw' && transaction.to === operation.chequebookAddress && transaction.data === `0x${CHEQUEBOOK_WITHDRAW_SELECTOR}${amountWord}`;
}
