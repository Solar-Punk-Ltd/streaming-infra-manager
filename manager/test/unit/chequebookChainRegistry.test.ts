import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookChainRegistry, chequebookEndpointMode } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChequebookReceiptInspector } from '../../src/domain/chequebook/ChequebookReceiptInspector.js';
import { transferContext, transactionHash } from '../support/chequebookOperations.js';

const reader = (chainId = 100) => ({
  async chainId() { return chainId; }, async transactionCount() { return '8'; }, async transaction() { return null; },
  async receipt() { return null; }, async blockTransactions() { return null; },
  async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; },
});

describe('trusted runtime chequebook chain registry', () => {
  it('selects by frozen chain id and works without a current profile', async () => {
    let selected = '';
    const registry = new ChequebookChainRegistry('{"100":"https://rpc.example.invalid/private-token"}', endpoint => { selected = endpoint; return reader(); });
    const inspector = new ChequebookReceiptInspector(async operation => registry.forChain(operation.chainId));
    const result = await inspector.inspect({ ...transferContext, tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da', direction: 'deposit', amountPlur: '1', transactionHash });
    assert.deepEqual(result, { kind: 'pending', reason: 'awaiting_transaction' });
    assert.equal(selected, 'https://rpc.example.invalid/private-token');
    assert.equal(JSON.stringify(registry), '{}');
  });

  it('refuses missing, unsupported and mismatched chains before returning a reader', async () => {
    let created = 0;
    const empty = new ChequebookChainRegistry(undefined, () => { created++; return reader(); });
    await assert.rejects(empty.forChain(100), /chain/i);
    assert.equal(created, 0);
    const wrong = new ChequebookChainRegistry('{"100":"https://rpc.example.invalid"}', () => reader(1));
    await assert.rejects(wrong.forChain(100), /chain/i);
    await assert.rejects(wrong.forChain(31337), /chain/i);
  });

  it('rejects malformed runtime configuration with fixed errors and never retains raw failures', async () => {
    for (const config of ['synthetic-private-config', '[]', '{"0100":"https://rpc.example.invalid"}', '{"100":"ws://rpc.example.invalid"}', '{"31337":"https://rpc.example.invalid"}', '{"100":123}']) {
      assert.throws(() => new ChequebookChainRegistry(config), error => error instanceof Error && error.name === 'ChequebookConfigurationError' && !error.message.includes('private-config'));
    }
    const failed = new ChequebookChainRegistry('{"100":"https://rpc.example.invalid/private-token"}', () => { throw new Error('synthetic-private-config'); });
    await assert.rejects(failed.forChain(100), error => error instanceof Error && !error.message.includes('private-config') && !error.message.includes('private-token'));
  });

  it('requires an explicit direct-endpoint mode and refuses unknown modes', () => {
    assert.equal(chequebookEndpointMode(undefined), 'disabled');
    assert.equal(chequebookEndpointMode('disabled'), 'disabled');
    assert.equal(chequebookEndpointMode('direct'), 'direct');
    assert.throws(() => chequebookEndpointMode('proxy'), /configuration/i);
  });
});
