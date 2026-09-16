import type { StackVersion } from '@streaming-infra-manager/common';

import {
  apiFetch,
  checkSessionAfterStreamClosed,
  failWith,
  getJson,
  send,
  sendJson,
} from '../http';
import { readScriptStream } from '../scriptStream';

export function fetchVersions(): Promise<StackVersion[]> {
  return getJson<StackVersion[]>('/versions');
}

export function setDefaultVersion(id: number): Promise<void> {
  return send('POST', `/versions/${id}/default`, {});
}

/**
 * Turns Tested on for the shown build, or off. Legacy rows carry a null build
 * identity and retain their commit-bound approval until migration.
 */
export function setVersionTested(
  id: number,
  tested: boolean,
  shownCommit: string | null,
  shownBuild: string | null,
): Promise<StackVersion> {
  return sendJson<StackVersion>(
    'PATCH',
    `/versions/${id}`,
    tested ? { tested, commitSha: shownCommit, buildId: shownBuild } : { tested },
  );
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

  const code = await readScriptStream(res.body, (event) => {
    if (event.kind === 'error') {
      handlers.onLine(buildLine(event.message, true));
      return;
    }
    for (const text of event.chunk.split('\n')) {
      if (text !== '') handlers.onLine(buildLine(text, event.isError));
    }
  });

  if (code === null) {
    // A stream that stops without a done frame is what a session ending
    // mid-build looks like from here, and nothing else on the page is fetching
    // to find that out. Asked before the message, so the operator lands on the
    // sign-in page rather than reading that the build broke.
    await checkSessionAfterStreamClosed();
    throw new Error('The build stream ended before the build did.');
  }
  return { code };
}
