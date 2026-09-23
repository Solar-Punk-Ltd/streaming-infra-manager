import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from '../composeLabels.js';
import { completeLines } from '../dockerStream.js';
import type { LogWindow } from '../logWindow.js';

/**
 * One service's log lines that carry a marker, read on another host.
 *
 * The command runs in the remote user's shell over the ssh path every other
 * read of a remote daemon takes, and filters there, so only the marked lines
 * cross the connection. It frames its answer because a pipeline into grep
 * reports grep's status alone: without the frame, no container, a quiet log
 * and a failed read would all arrive as the same empty answer.
 */

/** A compose project or service name, the shape the stack gives both. */
const COMPOSE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Printable ASCII but the single quote, so a marker cannot leave the quotes it is put in. */
const QUOTABLE_MARKER = /^[\x20-\x26\x28-\x7e]+$/;

const NO_CONTAINER = 'container=none';
const RUNNING_CONTAINER = 'container=running';
const LOGS_EXIT = 'docker-logs-exit=';
const LOGS_READ_WHOLE = `${LOGS_EXIT}0`;

export type RemoteLogLines =
  | { container: 'none' }
  | { container: 'running'; lines: string[] };

export function remoteLogLinesCommand(
  project: string,
  service: string,
  marker: string,
  window: LogWindow,
): string {
  if (!COMPOSE_NAME.test(project) || !COMPOSE_NAME.test(service)) {
    throw new Error('Invalid Compose project or service');
  }
  if (!QUOTABLE_MARKER.test(marker)) throw new Error('Invalid log marker');
  if (!isPositiveWhole(window.sinceSeconds) || !isPositiveWhole(window.tailLines)) {
    throw new Error('Invalid log window');
  }

  return [
    `ids=$(docker ps -q --no-trunc --filter 'label=${COMPOSE_PROJECT_LABEL}=${project}' --filter 'label=${COMPOSE_SERVICE_LABEL}=${service}') || exit 1`,
    // The first id, cut at the first character an id cannot hold. Word
    // splitting would do it in sh but not in zsh, which a login shell can be.
    'id=${ids%%[!0-9a-f]*}',
    `if [ -z "$id" ]; then echo '${NO_CONTAINER}'; exit 0; fi`,
    `echo '${RUNNING_CONTAINER}'`,
    // The bare `echo` ends a last log line that had no newline of its own, so
    // the status always arrives on a line by itself.
    `{ docker logs --since ${window.sinceSeconds}s --tail ${window.tailLines} "$id" 2>&1; logs_status=$?; echo; echo "${LOGS_EXIT}$logs_status"; } | grep -F -e '${marker}' -e '${LOGS_EXIT}'`,
  ].join('; ');
}

/**
 * What the command's output says. Throws, naming nothing it read, when the
 * log read failed or the answer is in any other shape.
 */
export function remoteLogLinesFrom(output: string, marker: string): RemoteLogLines {
  const [first, ...rest] = completeLines(output);
  if (first === NO_CONTAINER && rest.length === 0) return { container: 'none' };
  if (first !== RUNNING_CONTAINER) throw new Error('The remote log answer was unreadable');
  // The status line comes last because `echo` runs after `docker logs` has
  // finished, so a line quoting it from inside the log cannot stand in for it.
  if (rest.pop() !== LOGS_READ_WHOLE) throw new Error('The remote log could not be read');
  return { container: 'running', lines: rest.filter((line) => line.includes(marker)) };
}

function isPositiveWhole(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
