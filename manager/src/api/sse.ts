import { Request, Response } from 'express';

import type { OpenStreams } from '../domain/auth/OpenStreams.js';
import { RunHandle, RunOutcome } from '../domain/ScriptRunner.js';
import { signedInSession } from './middleware/requireSession.js';

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

export interface AuthenticatedRunStream {
  isOpen(): boolean;
  release(): void;
}

/** Registers before an awaited run is admitted, so revocation also closes a pending response. */
export function registerAuthenticatedRunStream(
  req: Request,
  res: Response,
  openStreams: OpenStreams,
): AuthenticatedRunStream {
  const session = signedInSession(req);
  let closed = false;
  let registered = true;
  const unregister = openStreams.open(session.tokenHash, session.user.id, () => {
    closed = true;
    endEventStream(res);
  });
  const onClosed = (): void => {
    closed = true;
    release();
  };
  const release = (): void => {
    if (!registered) return;
    registered = false;
    unregister();
    res.off('close', onClosed);
    res.off('error', onClosed);
  };
  res.on('close', onClosed);
  res.on('error', onClosed);
  return { isOpen: () => !closed && !res.writableEnded, release };
}

/**
 * Bridge a ScriptRunner.RunHandle to an Express response as Server-Sent Events.
 *
 * Events emitted:
 *   - start  { script, args }     emitted before the first stdout/stderr
 *   - stdout { chunk }
 *   - stderr { chunk }
 *   - error  { message }          spawn / runtime failures
 *   - done   { code, signal }     always last, and closes the connection.
 *                                 `signal` is what says a run was killed
 *                                 rather than finished, because a killed run
 *                                 has no exit code of its own and reports -1.
 */
export function pipeRunHandleToSSE(
  res: Response,
  handle: RunHandle,
  meta: { script: string; args: string[] },
  opts: { killOnClose?: boolean; authenticated?: AuthenticatedRunStream } = {},
): void {
  if (opts.authenticated && !opts.authenticated.isOpen()) {
    opts.authenticated.release();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientGone = false;
  let detached = false;

  const send = (event: string, data: unknown): void => {
    if (clientGone || res.writableEnded) {
      return;
    }
        
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onStdout = (chunk: string): void => send('stdout', { chunk });
  const onStderr = (chunk: string): void => send('stderr', { chunk });
  const onError = (err: Error): void => send('error', { message: err.message });
  const onDone = (payload: RunOutcome): void => {
    send('done', payload);
    detach();
    if (!res.writableEnded) {
      res.end();
    }
  };

  function detach(): void {
    if (detached) return;
    detached = true;
    handle.emitter.off('stdout', onStdout);
    handle.emitter.off('stderr', onStderr);
    handle.emitter.off('error', onError);
    handle.emitter.off('done', onDone);
    res.off('close', onResponseClosed);
    res.off('error', onResponseClosed);
    opts.authenticated?.release();
  }

  const onResponseClosed = (): void => {
    if (clientGone) return;
    clientGone = true;
    detach();
    if (opts.killOnClose) handle.kill();
  };

  handle.emitter.on('stdout', onStdout);
  handle.emitter.on('stderr', onStderr);
  handle.emitter.on('error', onError);
  handle.emitter.on('done', onDone);

  send('start', meta);

  res.on('close', onResponseClosed);
  res.on('error', onResponseClosed);
}
