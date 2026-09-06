import { Response } from 'express';

import { RunHandle } from '../domain/ScriptRunner.js';

/**
 * Ends a stream from the server's side, so the browser sees it stop now.
 *
 * The socket goes with the response: an SSE response is chunked over a
 * keep-alive connection, and ending the response alone leaves that connection
 * sitting there.
 */
export function endEventStream(res: Response): void {
  res.end();
  res.socket?.destroy();
}

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

  let clientGone = false;

  const send = (event: string, data: unknown): void => {
    if (clientGone || res.writableEnded) {
      return;
    }
        
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onStdout = (chunk: string): void => send('stdout', { chunk });
  const onStderr = (chunk: string): void => send('stderr', { chunk });
  const onError = (err: Error): void => send('error', { message: err.message });
  const onDone = (payload: { code: number }): void => {
    send('done', payload);
    detach();
    if (!res.writableEnded) {
      res.end();
    }
  };


  function detach(): void {
    handle.emitter.off('stdout', onStdout);
    handle.emitter.off('stderr', onStderr);
    handle.emitter.off('error', onError);
    handle.emitter.off('done', onDone);
  }

  handle.emitter.on('stdout', onStdout);
  handle.emitter.on('stderr', onStderr);
  handle.emitter.on('error', onError);
  handle.emitter.on('done', onDone);

  send('start', meta);

  res.on('close', () => {
    clientGone = true;
    detach();
    if (opts.killOnClose) handle.kill();
  });
}
