import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTransferIntent, sameTransferIntent } from '../../src/domain/chequebook/operationIdentity.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';

const replacement = '22222222-2222-4222-8222-222222222222';
describe('immutable profile generation in transfer intent', () => {
  it('requires a valid generation and includes it in exact request identity', () => {
    const intent = transferIntent();
    for (const profileInstanceId of [undefined, null, '', 'not-a-generation']) {
      assert.throws(() => normalizeTransferIntent({ ...intent, profileInstanceId } as never), /generation/i);
    }
    assert.equal(sameTransferIntent(intent, { ...intent, profileInstanceId: replacement }), false);
  });

  it('replays the original generation before profile lookup and refuses changing it under the same request UUID', async () => {
    const repository = new InMemoryChequebookOperations();
    const intent = transferIntent();
    const submitted = await new ChequebookSubmission(repository, async () => ({ context: transferContext, dispose() {}, preflight: async () => {},
      send: async () => ({ transactionHash: `0x${'cd'.repeat(32)}` }) })).submit(intent);
    const afterDeletion = new ChequebookSubmission(repository, async () => { assert.fail('Replay must not prepare a deleted or replacement profile'); });
    assert.deepEqual((await afterDeletion.submit(intent)).operation, submitted.operation);
    const conflict = await afterDeletion.submit({ ...intent, profileInstanceId: replacement });
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.operation.profileInstanceId, intent.profileInstanceId);
  });
});
