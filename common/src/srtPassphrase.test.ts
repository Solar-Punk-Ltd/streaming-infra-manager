import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SRT_PASSPHRASE_MAX,
  SRT_PASSPHRASE_MIN,
  generateSrtPassphrase,
  isValidSrtPassphrase,
} from './srtPassphrase.js';

describe('isValidSrtPassphrase', () => {
  it('accepts the unreserved character set at both length bounds', () => {
    assert.equal(isValidSrtPassphrase('a'.repeat(SRT_PASSPHRASE_MIN)), true);
    assert.equal(isValidSrtPassphrase('a'.repeat(SRT_PASSPHRASE_MAX)), true);
    assert.equal(isValidSrtPassphrase('aA0._~-aA0._~-'), true);
  });

  it('rejects lengths libsrt itself would refuse', () => {
    assert.equal(
      isValidSrtPassphrase('a'.repeat(SRT_PASSPHRASE_MIN - 1)),
      false,
    );
    assert.equal(
      isValidSrtPassphrase('a'.repeat(SRT_PASSPHRASE_MAX + 1)),
      false,
    );
    assert.equal(isValidSrtPassphrase(''), false);
  });

  // Each of these breaks a different hop: sed, the env file, the srs.conf
  // directive, or the SRT publish URL. See srtPassphrase.ts.
  it('rejects punctuation that would be reinterpreted downstream', () => {
    for (const bad of [
      'pass/phrase1', // ends sed's s/// expression
      'pass&phrase1', // sed whole-match expansion, and an extra URL param
      'pass\\phrase1', // sed escape
      'pass#phrase1', // env-file comment
      'pass phrase1', // env value trimming, srs.conf token break
      'pass;phrase1', // ends the srs.conf directive
      'pass"phrase1', // quote-stripped back off by the env parser
      'pass=phrase1', // splits the URL query pair
      'pass%phrase1', // percent-escape in the URL
      'pass\nphrase1', // a second env line entirely
    ]) {
      assert.equal(isValidSrtPassphrase(bad), false, `should reject ${bad}`);
    }
  });
});

describe('generateSrtPassphrase', () => {
  it('only ever produces a passphrase the rules accept', () => {
    // The alphabet is a hand-kept subset of the regex's character class, so this
    // is the check that catches the two drifting apart.
    for (let i = 0; i < 200; i += 1) {
      const generated = generateSrtPassphrase();
      assert.equal(
        isValidSrtPassphrase(generated),
        true,
        `generated an invalid passphrase: ${generated}`,
      );
    }
  });

  it('honours a requested length, and refuses one libsrt would reject', () => {
    assert.equal(generateSrtPassphrase(SRT_PASSPHRASE_MIN).length, SRT_PASSPHRASE_MIN);
    assert.equal(generateSrtPassphrase(SRT_PASSPHRASE_MAX).length, SRT_PASSPHRASE_MAX);
    assert.throws(() => generateSrtPassphrase(SRT_PASSPHRASE_MIN - 1));
    assert.throws(() => generateSrtPassphrase(SRT_PASSPHRASE_MAX + 1));
  });

  it('does not return the same passphrase twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSrtPassphrase()));
    assert.equal(seen.size, 50);
  });
});
