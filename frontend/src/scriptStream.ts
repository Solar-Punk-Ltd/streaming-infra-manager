/**
 * Reading what one of the manager's scripts did, as it does it.
 *
 * A deploy, a stop and a build all answer with Server-Sent Events rather than
 * JSON: the manager writes 200 before the script starts, sends its output a
 * frame at a time, and puts the exit code in the last frame. So the status
 * line says only that the script started, and reading it alone reported a
 * deploy.sh that exited 1 as a success.
 *
 * `EventSource` cannot read these, because it only ever sends a GET and
 * carries no way to set the header that makes a cross-site write impossible.
 * The response body is read here instead, through the same `apiFetch` every
 * other call uses.
 */

/** One frame of a script route's answer. */
export type ScriptEvent =
  | { kind: 'output'; chunk: string; isError: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'done'; code: number };

/** Everything a script says before it says how it ended. */
export type ScriptProgress = Exclude<ScriptEvent, { kind: 'done' }>;

const EVENT_PREFIX = 'event: ';
const DATA_PREFIX = 'data: ';

export function parseScriptFrame(frame: string): ScriptEvent | null {
  const lines = frame.split('\n');
  const event = lines
    .find((line) => line.startsWith(EVENT_PREFIX))
    ?.slice(EVENT_PREFIX.length);
  const data = lines
    .find((line) => line.startsWith(DATA_PREFIX))
    ?.slice(DATA_PREFIX.length);
  if (!event || data === undefined) return null;

  const payload = parsePayload(data);

  if (event === 'stdout' || event === 'stderr') {
    return {
      kind: 'output',
      chunk: typeof payload.chunk === 'string' ? payload.chunk : '',
      isError: event === 'stderr',
    };
  }
  if (event === 'error') {
    return {
      kind: 'error',
      message: typeof payload.message === 'string' ? payload.message : 'unknown failure',
    };
  }
  if (event === 'done') {
    return { kind: 'done', code: typeof payload.code === 'number' ? payload.code : -1 };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePayload(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The exit code the last frame carried, or null when no last frame arrived. */
export async function readScriptStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (event: ScriptProgress) => void,
): Promise<number | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let code: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split('\n\n');
    // The last piece is whatever arrived after the final blank line, which is
    // half a frame until more bytes turn up.
    buffered = frames.pop() ?? '';

    for (const frame of frames) {
      const event = parseScriptFrame(frame);
      if (!event) continue;
      if (event.kind === 'done') code = event.code;
      else onProgress(event);
    }
  }

  return code;
}

/** A script route whose stream stopped before the script did. */
export class ScriptStreamEndedError extends Error {
  constructor() {
    super('The manager stopped reporting before the run finished.');
    this.name = 'ScriptStreamEndedError';
  }
}

/** Waits for a script to finish, and refuses whatever it refused. */
export async function readScriptOutcome(body: ReadableStream<Uint8Array>): Promise<void> {
  const failures: string[] = [];
  const code = await readScriptStream(body, (event) => {
    if (event.kind === 'error') failures.push(event.message);
  });

  if (code === null) throw new ScriptStreamEndedError();
  if (failures.length > 0) throw new Error(failures.join(' '));
  if (code !== 0) throw new Error(`The script exited with code ${code}.`);
}
