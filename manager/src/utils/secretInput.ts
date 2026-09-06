import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Reading a password without it being seen or stored.
 *
 * The terminal prompt echoes nothing, and a piped password is taken from stdin
 * so it never becomes an argument, an environment variable or a file. Neither
 * value is logged anywhere by anything in this module.
 *
 * The streams are parameters so the no-echo behaviour can be tested without a
 * terminal. Nothing but the tests passes anything but the defaults.
 */
export interface SecretInputStreams {
  input?: NodeJS.ReadableStream;
  echo?: NodeJS.WritableStream;
}

/** An output readline can write to, and that can be silenced mid-question. */
class HidableOutput extends Writable {
  hidden = false;

  constructor(private readonly destination: NodeJS.WritableStream) {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.hidden) this.destination.write(chunk);
    callback();
  }
}

export function promptSecret(
  prompt: string,
  streams: SecretInputStreams = {},
): Promise<string> {
  const echo = streams.echo ?? process.stdout;
  const output = new HidableOutput(echo);
  const rl = createInterface({
    input: streams.input ?? process.stdin,
    output,
    terminal: true,
  });

  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      // The Enter that ended the answer was swallowed with the echo.
      echo.write('\n');
      resolve(answer);
    });
    // Set after question(), which writes the prompt itself.
    output.hidden = true;
  });
}

/**
 * The whole of stdin as the secret, minus one trailing newline, which is what
 * `op read ... | ...` and `echo ... |` both add.
 */
export async function readSecretFromStdin(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
