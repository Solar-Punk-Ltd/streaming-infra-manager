import { Response } from 'express';

import { RunHandle } from '../domain/ScriptRunner.js';

/**
 * Bridge a ScriptRunner.RunHandle to an Express response as Server-Sent Events.
 *
 * Events emitted:
 *   - start  { script, args }     emitted before the first stdout/stderr
 *   - stdout { chunk }
 *   - stderr { chunk }
 *   - error  { message }          spawn / runtime failures
 *   - done   { code }             always last; closes the connection
 */
export function pipeRunHandleToSSE(
  res: Response,
  handle: RunHandle,
  meta: { script: string; args: string[] },
  opts: { killOnClose?: boolean } = {},
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', meta);

  handle.emitter.on('stdout', (chunk: string) => send('stdout', { chunk }));
  handle.emitter.on('stderr', (chunk: string) => send('stderr', { chunk }));
  handle.emitter.on('error', (err: Error) =>
    send('error', { message: err.message }),
  );
  handle.emitter.on('done', (payload: { code: number }) => {
    send('done', payload);
    res.end();
  });

  if (opts.killOnClose) {
    res.on('close', () => handle.kill());
  }
}
