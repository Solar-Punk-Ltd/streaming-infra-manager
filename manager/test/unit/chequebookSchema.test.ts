/**
 * What the two chequebook writes accept as an amount.
 *
 * Unit test, no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * The field is PLUR, bee's integer unit, and 1 BZZ is 10^16 of them. So a value
 * that looks like a perfectly reasonable amount of BZZ is the dangerous input
 * here: `0.5` would either be truncated to nothing or move ten thousand million
 * million times less than the operator meant. It has to be refused rather than
 * interpreted, which is why the conversion happens in the frontend and only a
 * whole number arrives.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { moveBzzSchema } from '../../src/schemas/chequebook.js';

async function accepts(body: unknown): Promise<boolean> {
  try {
    await moveBzzSchema.validate(body, { abortEarly: false });
    return true;
  } catch {
    return false;
  }
}

describe('moveBzzSchema', () => {
  it('accepts a positive whole number of PLUR', async () => {
    assert.equal(await accepts({ amount: '5000000000000000' }), true);
    assert.equal(await accepts({ amount: '1' }), true);
  });

  it('refuses a decimal, which would be a BZZ amount in a PLUR field', async () => {
    for (const amount of ['0.5', '1.0', '.5', '1,5']) {
      assert.equal(await accepts({ amount }), false, `${amount} was accepted`);
    }
  });

  it('refuses hex, which bee would read as something else entirely', async () => {
    assert.equal(await accepts({ amount: '0x10' }), false);
    assert.equal(await accepts({ amount: '0xdeadbeef' }), false);
  });

  it('refuses zero, a leading zero and a negative amount', async () => {
    for (const amount of ['0', '007', '-1', '+1']) {
      assert.equal(await accepts({ amount }), false, `${amount} was accepted`);
    }
  });

  it('refuses exponent notation rather than expanding it', async () => {
    assert.equal(await accepts({ amount: '5e15' }), false);
  });

  it('refuses a missing or empty amount', async () => {
    assert.equal(await accepts({}), false);
    assert.equal(await accepts({ amount: '' }), false);
    assert.equal(await accepts({ amount: '   ' }), false);
  });

  it('caps the digits, so no request turns into an unbounded bigint', async () => {
    assert.equal(await accepts({ amount: '1'.repeat(30) }), true);
    assert.equal(await accepts({ amount: '1'.repeat(31) }), false);
  });

  it('drops anything else in the body rather than passing it to bee', async () => {
    const validated = await moveBzzSchema.validate(
      { amount: '1', to: '0xsomewhere-else' },
      { stripUnknown: true },
    );
    assert.deepEqual(validated, { amount: '1' });
  });
});
