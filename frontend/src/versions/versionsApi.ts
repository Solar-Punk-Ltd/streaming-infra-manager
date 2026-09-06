import type { StackVersion } from '@streaming-infra-manager/common';

import {
  apiFetch,
  checkSessionAfterStreamClosed,
  failWith,
  getJson,
  send,
  sendJson,
} from '../http';

export function fetchVersions(): Promise<StackVersion[]> {
  return getJson<StackVersion[]>('/versions');
}

export function setDefaultVersion(id: number): Promise<void> {
  return send('POST', `/versions/${id}/default`, {});
}

export function setVersionTested(
  id: number,
  tested: boolean,
): Promise<StackVersion> {
  return sendJson<StackVersion>('PATCH', `/versions/${id}`, { tested });
}

export function removeVersion(id: number): Promise<void> {
  return send('DELETE', `/versions/${id}`);
}

/** One line of a running build, as the pane shows it. */
export interface BuildLine {
  /**
   * Rises for the life of the page. A build prints the same line many times
   * over, so the position in the list is not an identity: React reused a row
   * that had scrolled away and the pane redrew lines that had not changed.
   */
  id: number;
  text: string;
  isError: boolean;
}

let nextLineId = 0;

function buildLine(text: string, isError: boolean): BuildLine {
  return { id: nextLineId++, text, isError };
}

export interface BuildResult {
  code: number;
}

export interface BuildHandlers {
  onLine: (line: BuildLine) => void;
}

export function addVersion(
  name: string,
  ref: string,
  handlers: BuildHandlers,
  signal: AbortSignal,
): Promise<BuildResult> {
  return streamBuild('/versions', { name, ref }, handlers, signal);
}

export function updateVersion(
  id: number,
  handlers: BuildHandlers,
  signal: AbortSignal,
): Promise<BuildResult> {
  return streamBuild(`/versions/${id}/update`, {}, handlers, signal);
}

/**
 * Runs a build and reports its log as it arrives.
 *
 * A build is a POST that answers with Server-Sent Events, which `EventSource`
 * cannot do: it only ever sends a GET, and it carries no way to add the header
 * that makes a cross-site write impossible. So the response body is read here
 * instead, one frame at a time, through the same `apiFetch` every other call
 * uses.
 *
 * The signal ends the read. A build streams for minutes, so a page left before
 * it finishes would otherwise keep a reader running against a response nothing
 * is rendering.
 */
async function streamBuild(
  path: string,
  body: unknown,
  handlers: BuildHandlers,
  signal: AbortSignal,
): Promise<BuildResult> {
  const res = await apiFetch(path, { method: 'POST', body, signal });
  if (!res.ok) await failWith(res, `the build could not be started (${res.status})`);
  if (!res.body) {
    throw new Error('The manager answered the build with no stream to read.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let result: BuildResult | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split('\n\n');
    // The last piece is whatever arrived after the final blank line, which is
    // half a frame until more bytes turn up.
    buffered = frames.pop() ?? '';

    for (const frame of frames) {
      const finished = handleFrame(frame, handlers);
      if (finished) result = finished;
    }
  }

  if (!result) {
    // A stream that stops without a done frame is what a session ending
    // mid-build looks like from here, and nothing else on the page is fetching
    // to find that out. Asked before the message, so the operator lands on the
    // sign-in page rather than reading that the build broke.
    await checkSessionAfterStreamClosed();
    throw new Error('The build stream ended before the build did.');
  }
  return result;
}

const EVENT_PREFIX = 'event: ';
const DATA_PREFIX = 'data: ';

/** Answers the build result when the frame was the last one, else null. */
function handleFrame(frame: string, handlers: BuildHandlers): BuildResult | null {
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
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
    for (const text of chunk.split('\n')) {
      if (text !== '') handlers.onLine(buildLine(text, event === 'stderr'));
    }
    return null;
  }
  if (event === 'error') {
    const message =
      typeof payload.message === 'string' ? payload.message : 'unknown failure';
    handlers.onLine(buildLine(message, true));
    return null;
  }
  if (event === 'done') {
    return { code: typeof payload.code === 'number' ? payload.code : -1 };
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
