/**
 * Why the manager refused a chequebook transfer, in the words the page shows.
 *
 * The manager sets a cause where it decides to refuse and answers it with the
 * refusal. The page turns it back into a sentence. Both read the list and the
 * sentences from here, so a cause the manager can answer always has words on
 * the page, and nothing the page shows can come from upstream text.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BEE_BRIDGE_BINARIES,
  BEE_BRIDGE_CHECKS,
  CHEQUEBOOK_REFUSAL_CAUSES,
  chequebookRefusal,
  chequebookRefusalSentence,
  isChequebookRefusal,
} from './chequebookRefusals.js';

const EM_DASH = '—';
function assertPlain(sentence: string): void {
  assert.equal(sentence.includes(EM_DASH), false, sentence);
  assert.equal(sentence.includes(';'), false, sentence);
}

const everyRefusal = () => [
  ...CHEQUEBOOK_REFUSAL_CAUSES.filter((cause) => cause !== 'bridge_not_qualified').map((cause) => chequebookRefusal(cause)),
  chequebookRefusal('bridge_not_qualified'),
  ...BEE_BRIDGE_CHECKS.map((check) => chequebookRefusal('bridge_not_qualified', check)),
];

describe('chequebook refusal causes', () => {
  it('names at least the causes a transfer on a new host can meet', () => {
    for (const cause of ['docker_unreachable', 'bee_container_not_found', 'bridge_not_qualified', 'chain_endpoint_missing',
      'chain_unreachable', 'wrong_chain', 'target_changed'] as const) {
      assert.ok(CHEQUEBOOK_REFUSAL_CAUSES.includes(cause), cause);
    }
  });

  it('gives every cause, and every failed bridge check, a sentence of its own', () => {
    const sentences = everyRefusal().map(chequebookRefusalSentence);
    assert.equal(new Set(sentences).size, sentences.length, 'no two refusals read the same');
    for (const sentence of sentences) {
      assert.ok(sentence.length > 40, sentence);
      assert.ok(sentence.endsWith('.'), sentence);
    }
  });

  it('writes plain sentences, with no em-dash and no semicolon', () => {
    for (const sentence of everyRefusal().map(chequebookRefusalSentence)) assertPlain(sentence);
  });

  it('says that nothing was sent whenever the manager refused before recording the transfer', () => {
    for (const refusal of everyRefusal()) assert.match(chequebookRefusalSentence(refusal), /Nothing was sent\./);
  });

  it('names the missing path when the bridge check found one missing', () => {
    for (const [check, path] of Object.entries(BEE_BRIDGE_BINARIES)) {
      assert.ok((BEE_BRIDGE_CHECKS as readonly string[]).includes(check), `${check} is one of the checks`);
      assert.ok(chequebookRefusalSentence(chequebookRefusal('bridge_not_qualified', check as keyof typeof BEE_BRIDGE_BINARIES)).includes(path), check);
    }
    assert.match(chequebookRefusalSentence(chequebookRefusal('bridge_not_qualified', 'dev_tcp')), /\/dev\/tcp/);
  });

  it('names the setting to change when a manager setting is the cause', () => {
    assert.match(chequebookRefusalSentence(chequebookRefusal('docker_setting_invalid')), /CHEQUEBOOK_DOCKER_TRANSPORTS/);
    assert.match(chequebookRefusalSentence(chequebookRefusal('chain_setting_invalid')), /CHEQUEBOOK_RPC_ENDPOINTS/);
    assert.match(chequebookRefusalSentence(chequebookRefusal('chain_endpoint_missing')), /CHEQUEBOOK_RPC_ENDPOINTS/);
  });

  it('carries a failed check only on a bridge that was not qualified', () => {
    assert.throws(() => chequebookRefusal('docker_unreachable', 'bash'));
    assert.deepEqual(chequebookRefusal('bridge_not_qualified', 'bash'), { cause: 'bridge_not_qualified', check: 'bash' });
    assert.deepEqual(chequebookRefusal('wrong_chain'), { cause: 'wrong_chain', check: null });
    assert.ok(Object.isFrozen(chequebookRefusal('wrong_chain')));
  });

  it('recognises only a refusal drawn from the closed lists', () => {
    for (const refusal of everyRefusal()) assert.equal(isChequebookRefusal(refusal), true);
    for (const value of [null, undefined, 'docker_unreachable', {}, { cause: 'docker_unreachable' },
      { cause: 'Connection refused by 10.0.0.1', check: null }, { cause: 'docker_unreachable', check: 'bash' },
      { cause: 'bridge_not_qualified', check: '/usr/bin/whoami' }, { cause: 'wrong_chain', check: null, detail: 'x' }]) {
      assert.equal(isChequebookRefusal(value), false, JSON.stringify(value));
    }
  });
});
