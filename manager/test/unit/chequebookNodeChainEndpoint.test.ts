/**
 * Where a transfer reads the chain when CHEQUEBOOK_RPC_ENDPOINTS names none.
 *
 * The default is the endpoint the node being funded was started with, read
 * from its container's command on the Docker connection the transfer owns.
 * It is held to the same shape checks as a configured endpoint, it must answer
 * the node's own chain before it is used, a configured endpoint always wins,
 * and no endpoint ever reaches an error.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { nodeChainEndpoint } from '../../src/domain/chequebook/DockerBeeBinding.js';
import { ChequebookChainRegistry, type ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChainReadError } from '../../src/domain/errors/ChainReadError.js';

const node = `0x${'ab'.repeat(20)}`;
const inspectWith = (Cmd: unknown) => ({ Config: { Cmd } });
const reader = (chainId = 100, unreachable = false): ChequebookChainReader => ({
  async chainId() { if (unreachable) throw new Error('fetch failed https://node-rpc.example.invalid/node-key'); return chainId; },
  async transactionCount() { return '8'; }, async transaction() { return null; }, async receipt() { return null; },
  async blockTransactions() { return null; }, async blockHeader() { return null; },
});
const refusedAs = (cause: ChequebookRefusalCause) => (error: unknown) => {
  assert.ok(error instanceof ChainReadError, String(error));
  assert.equal(error.refusal.cause, cause);
  assert.equal(JSON.stringify({ ...error, message: error.message }).includes('example.invalid'), false, 'no endpoint reaches the error');
  return true;
};

describe('the chain endpoint a Bee container was started with', () => {
  it('reads the flag the stack passes, in either spelling cobra accepts', () => {
    assert.equal(nodeChainEndpoint(inspectWith(['start', '--api-addr=:1633', '--blockchain-rpc-endpoint=https://node-rpc.example.invalid/node-key', '--full-node=false'])),
      'https://node-rpc.example.invalid/node-key');
    assert.equal(nodeChainEndpoint(inspectWith(['start', '--blockchain-rpc-endpoint', 'https://node-rpc.example.invalid/node-key'])),
      'https://node-rpc.example.invalid/node-key');
  });

  it('takes the last occurrence, as the flag parser does', () => {
    assert.equal(nodeChainEndpoint(inspectWith(['start', '--blockchain-rpc-endpoint=https://first.example.invalid',
      '--blockchain-rpc-endpoint=https://second.example.invalid'])), 'https://second.example.invalid');
  });

  it('answers none when the flag is absent, empty or unreadable', () => {
    for (const inspect of [inspectWith(['start', '--full-node=false']), inspectWith(['start', '--blockchain-rpc-endpoint=']),
      inspectWith(['start', '--blockchain-rpc-endpoint']), inspectWith(null), inspectWith('start --blockchain-rpc-endpoint=https://x.example.invalid'),
      inspectWith([7, { flag: true }]), {}, { Config: null }, null]) {
      assert.equal(nodeChainEndpoint(inspect), null, JSON.stringify(inspect));
    }
  });

  it('does not take a neighbouring flag that only starts the same way', () => {
    assert.equal(nodeChainEndpoint(inspectWith(['start', '--blockchain-rpc-endpoint-timeout=5s'])), null);
  });
});

describe('the chain registry with a node\'s own endpoint', () => {
  it('uses the node\'s endpoint when nothing is configured for its chain, once it answers that chain', async () => {
    const created: string[] = [];
    const registry = new ChequebookChainRegistry(undefined, endpoint => { created.push(endpoint); return reader(); });
    await registry.forPreparedNode(100, node, 'https://node-rpc.example.invalid/node-key');
    assert.deepEqual(created, ['https://node-rpc.example.invalid/node-key']);
  });

  it('lets a configured endpoint win over the node\'s own', async () => {
    const created: string[] = [];
    const registry = new ChequebookChainRegistry('{"100":"https://configured.example.invalid"}', endpoint => { created.push(endpoint); return reader(); });
    await registry.forPreparedNode(100, node, 'https://node-rpc.example.invalid/node-key');
    assert.deepEqual(created, ['https://configured.example.invalid']);
  });

  it('uses the node\'s endpoint for a chain the configuration does not name', async () => {
    const created: string[] = [];
    const registry = new ChequebookChainRegistry('{"1":"https://mainnet.example.invalid"}', endpoint => { created.push(endpoint); return reader(); });
    await registry.forPreparedNode(100, node, 'https://node-rpc.example.invalid/node-key');
    assert.deepEqual(created, ['https://node-rpc.example.invalid/node-key']);
  });

  it('refuses a node endpoint on the wrong chain, and one that does not answer', async () => {
    await assert.rejects(new ChequebookChainRegistry(undefined, () => reader(1)).forPreparedNode(100, node, 'https://node-rpc.example.invalid/node-key'),
      refusedAs('wrong_chain'));
    await assert.rejects(new ChequebookChainRegistry(undefined, () => reader(100, true)).forPreparedNode(100, node, 'https://node-rpc.example.invalid/node-key'),
      refusedAs('chain_unreachable'));
  });

  it('holds the node\'s endpoint to the same shape checks as a configured one, before any read', async () => {
    let created = 0;
    const registry = new ChequebookChainRegistry(undefined, () => { created++; return reader(); });
    for (const endpoint of [null, 'ws://node-rpc.example.invalid', 'https://user:secret@node-rpc.example.invalid', 'https://node-rpc.example.invalid/#fragment',
      'node-rpc.example.invalid', 'file:///etc/passwd', 'https://']) {
      await assert.rejects(registry.forPreparedNode(100, node, endpoint), refusedAs('chain_endpoint_missing'), String(endpoint));
    }
    assert.equal(created, 0);
  });

  it('refuses a chain with no pinned token whatever the node says', async () => {
    await assert.rejects(new ChequebookChainRegistry(undefined, () => reader(31337)).forPreparedNode(31337, node, 'https://node-rpc.example.invalid'),
      refusedAs('unsupported_chain'));
  });

  it('remembers the node\'s endpoint for its saved transfers, and reads the container again only when it does not know it', async () => {
    const created: string[] = []; let reads = 0;
    const registry = new ChequebookChainRegistry(undefined, endpoint => { created.push(endpoint); return reader(); });
    const readAgain = async () => { reads++; return 'https://reread.example.invalid'; };
    await registry.forSavedNode(100, node, readAgain);
    assert.equal(reads, 1, 'a manager that never prepared this node reads its container');
    await registry.forSavedNode(100, node, readAgain);
    assert.equal(reads, 1, 'and then remembers it');
    await registry.forPreparedNode(100, node, 'https://fresh.example.invalid');
    await registry.forSavedNode(100, node, readAgain);
    assert.equal(reads, 1);
    assert.deepEqual(created, ['https://reread.example.invalid', 'https://reread.example.invalid', 'https://fresh.example.invalid', 'https://fresh.example.invalid'],
      'a new preparation replaces what the saved transfers read through');
  });

  it('never reads a container for a saved transfer when the chain is configured', async () => {
    const registry = new ChequebookChainRegistry('{"100":"https://configured.example.invalid"}', () => reader());
    await registry.forSavedNode(100, node, async () => assert.fail('the configured endpoint wins'));
  });

  describe('when the remembered endpoint fails', () => {
    const remembered = 'https://remembered.example.invalid';
    const fresh = 'https://fresh.example.invalid';
    /** A registry that remembers `remembered` for the node, over endpoints whose answers each test sets. */
    async function rememberedRegistry() {
      const answers = new Map<string, number | 'down'>([[remembered, 100], [fresh, 100]]);
      const created: string[] = [];
      const registry = new ChequebookChainRegistry(undefined, endpoint => {
        created.push(endpoint);
        const answer = answers.get(endpoint) ?? 100;
        return reader(answer === 'down' ? 100 : answer, answer === 'down');
      });
      await registry.forPreparedNode(100, node, remembered);
      created.length = 0;
      let reads = 0;
      const readAgain = (endpoint: string | null | Error) => async () => {
        reads++;
        if (endpoint instanceof Error) throw endpoint;
        return endpoint;
      };
      return { registry, answers, created, readAgain, reads: () => reads };
    }

    it('reads the node once when the remembered endpoint does not answer, and uses the fresh one that verifies', async () => {
      const h = await rememberedRegistry();
      h.answers.set(remembered, 'down');
      await h.registry.forSavedNode(100, node, h.readAgain(fresh));
      assert.equal(h.reads(), 1, 'a remembered endpoint that stopped answering is not the last word');
      assert.deepEqual(h.created, [remembered, fresh]);
      await h.registry.forSavedNode(100, node, h.readAgain(remembered));
      assert.equal(h.reads(), 1, 'the fresh endpoint that verified replaced the remembered one');
      assert.deepEqual(h.created, [remembered, fresh, fresh]);
    });

    it('reads the node once when the remembered endpoint answers another chain', async () => {
      const h = await rememberedRegistry();
      h.answers.set(remembered, 1);
      await h.registry.forSavedNode(100, node, h.readAgain(fresh));
      assert.equal(h.reads(), 1);
      assert.deepEqual(h.created, [remembered, fresh]);
    });

    it('keeps the remembered endpoint when the fresh one does not verify either', async () => {
      const h = await rememberedRegistry();
      h.answers.set(remembered, 'down');
      h.answers.set(fresh, 1);
      await assert.rejects(h.registry.forSavedNode(100, node, h.readAgain(fresh)), refusedAs('wrong_chain'));
      assert.equal(h.reads(), 1, 'read once, no more');
      h.answers.set(remembered, 100);
      await h.registry.forSavedNode(100, node, h.readAgain(fresh));
      assert.equal(h.reads(), 1, 'the remembered endpoint answered again and was used without another read');
      assert.deepEqual(h.created, [remembered, fresh, remembered]);
    });

    it('reports the remembered endpoint\'s failure when the node cannot be read or names no endpoint', async () => {
      for (const readResult of [new Error('private container diagnostic'), null, 'ws://not-usable.example.invalid']) {
        const h = await rememberedRegistry();
        h.answers.set(remembered, 'down');
        await assert.rejects(h.registry.forSavedNode(100, node, h.readAgain(readResult)), refusedAs('chain_unreachable'), String(readResult));
        assert.equal(h.reads(), 1);
      }
    });

    for (const [failure, answer] of [['chain_unreachable', 'down'], ['wrong_chain', 1]] as const) {
      it(`reports a remembered endpoint's ${failure} as it stands when the node names the same one, without trying it twice`, async () => {
        const h = await rememberedRegistry();
        h.answers.set(remembered, answer);
        await assert.rejects(h.registry.forSavedNode(100, node, h.readAgain(remembered)), refusedAs(failure));
        assert.equal(h.reads(), 1, 'the node was read once rather than the remembered endpoint being trusted');
        assert.deepEqual(h.created, [remembered], 'the endpoint that just failed was not tried a second time');
        await assert.rejects(h.registry.forSavedNode(100, node, h.readAgain(remembered)), refusedAs(failure));
        assert.equal(h.reads(), 2, 'and the node is read again on the next check');
        assert.deepEqual(h.created, [remembered, remembered]);
      });
    }
  });

  it('says the endpoint is missing when the saved transfer\'s node cannot be read', async () => {
    const registry = new ChequebookChainRegistry(undefined, () => reader());
    await assert.rejects(registry.forSavedNode(100, node, async () => null), refusedAs('chain_endpoint_missing'));
    await assert.rejects(registry.forSavedNode(100, node, async () => { throw new Error('private container diagnostic'); }), refusedAs('chain_endpoint_missing'));
  });
});
