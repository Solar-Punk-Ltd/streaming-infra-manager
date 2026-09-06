/**
 * That the CLI never shows or keeps the password it is given.
 *
 * Unit test, no terminal: the prompt is driven through a pair of in-memory
 * streams. The claim being pinned is the one the whole "no plaintext anywhere"
 * rule rests on, and it is invisible in review because readline echoes what it
 * reads unless something stops it. If the muting is ever dropped, the password
 * appears in the operator's scrollback, and from there in whatever records it.
 */
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  promptSecret,
  readSecretFromStdin,
} from '../../src/utils/secretInput.js';

const SECRET = 'a-long-enough-password';

/** Collects everything written to it, as the terminal would show it. */
function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('promptSecret', () => {
  it('shows the prompt and nothing that was typed', async () => {
    const input = new PassThrough();
    const echo = capture();

    const answer = promptSecret('Password: ', {
      input,
      echo: echo.stream,
    });
    input.write(`${SECRET}\n`);

    assert.equal(await answer, SECRET);
    assert.match(echo.text(), /Password: /);
    assert.equal(
      echo.text().includes(SECRET),
      false,
      'the typed password must never reach the terminal',
    );
  });

  it('reads an empty answer as an empty answer', async () => {
    const input = new PassThrough();
    const echo = capture();

    const answer = promptSecret('Password: ', { input, echo: echo.stream });
    input.write('\n');

    assert.equal(await answer, '');
  });
});

describe('readSecretFromStdin', () => {
  it('takes the whole pipe, minus the newline a shell adds', async () => {
    for (const written of [SECRET, `${SECRET}\n`, `${SECRET}\r\n`]) {
      const input = new PassThrough();
      const read = readSecretFromStdin(input);
      input.end(written);

      assert.equal(await read, SECRET, JSON.stringify(written));
    }
  });

  it('keeps a password that contains spaces or its own newline', async () => {
    const multiline = 'two words\nand a second line';
    const input = new PassThrough();
    const read = readSecretFromStdin(input);
    input.end(`${multiline}\n`);

    assert.equal(await read, multiline);
  });

  it('reads nothing from an empty pipe, which the CLI refuses', async () => {
    const input = new PassThrough();
    const read = readSecretFromStdin(input);
    input.end();

    assert.equal(await read, '');
  });
});
