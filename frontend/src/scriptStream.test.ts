import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseScriptFrame,
  readScriptOutcome,
  readScriptStream,
  type ScriptProgress,
} from './scriptStream';

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

describe('what a deployment action actually did', () => {
  it('resolves when the script exited 0', async () => {
    await assert.doesNotReject(
      readScriptOutcome(
        streamOf(frame('start', { script: 'deploy.sh', args: [] }), frame('stdout', { chunk: 'up\n' }), frame('done', { code: 0 })),
      ),
    );
  });

  it('refuses a non-zero exit, which used to arrive as a green toast', async () => {
    await assert.rejects(
      readScriptOutcome(streamOf(frame('stdout', { chunk: 'building\n' }), frame('done', { code: 1 }))),
      /exited with code 1/,
    );
  });

  it('refuses with the words of the error frame when there was one', async () => {
    await assert.rejects(
      readScriptOutcome(streamOf(frame('error', { message: 'compose refused the deploy' }), frame('done', { code: 0 }))),
      /compose refused the deploy/,
    );
  });

  it('refuses a stream that stopped before the run did', async () => {
    await assert.rejects(
      readScriptOutcome(streamOf(frame('stdout', { chunk: 'half a deploy\n' }))),
      (caught: Error) => caught.name === 'ScriptStreamEndedError',
    );
  });
});

describe('the frames a script route answers with', () => {
  it('waits for the rest of a frame that arrived in pieces', async () => {
    const whole = frame('stdout', { chunk: 'one\ntwo' }) + frame('done', { code: 0 });
    const seen: ScriptProgress[] = [];

    const code = await readScriptStream(streamOf(whole.slice(0, 11), whole.slice(11)), (event) => seen.push(event));

    assert.equal(code, 0);
    assert.deepEqual(seen, [{ kind: 'output', chunk: 'one\ntwo', isError: false }]);
  });

  it('ignores a frame it cannot read rather than inventing an outcome', () => {
    assert.equal(parseScriptFrame('event: keepalive'), null);
    assert.equal(parseScriptFrame(': a comment'), null);
    assert.deepEqual(parseScriptFrame('event: done\ndata: not json'), { kind: 'done', code: -1 });
    assert.deepEqual(parseScriptFrame('event: stderr\ndata: {"chunk":"bad"}'), { kind: 'output', chunk: 'bad', isError: true });
  });
});
