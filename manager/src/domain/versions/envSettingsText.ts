import { envKeyIn } from './hostConfigCapture.js';

/**
 * The env files of a version's settings, read for the page and written back.
 *
 * Two shapes of file meet here. The version's `.env.sample`, which is the
 * documentation: every key carries the comment block above it, and the page
 * shows that block under the field. And the operator's own `.env`, which is
 * what the containers read. A save rewrites the value of the line it was asked
 * for and copies every other byte, because the file is edited over ssh as well
 * and a page that reflowed it would make the next diff unreadable.
 */

/** What one line assigns, split so the value can be replaced where it stands. */
const ASSIGNMENT_RE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)(.*?)(\r?)$/;

const COMMENT_RE = /^\s*#/;

/** The value one line assigns, or null for a line that assigns nothing. */
export function envValueIn(line: string): string | null {
  return ASSIGNMENT_RE.exec(line)?.[2] ?? null;
}

/**
 * What an env file assigns, by key, in the order the keys first appear. A key
 * assigned more than once answers its last value, which is the one a reader of
 * the file ends up with.
 */
export function envAssignmentsOf(text: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of text.split('\n')) {
    const key = envKeyIn(line);
    if (key !== null) assignments.set(key, envValueIn(line) ?? '');
  }
  return assignments;
}

/** One key of a version's sample, with what the sample says about it. */
export interface SampleSetting {
  key: string;
  value: string;
  description: string;
}

/** The keys a sample declares, in its own order, each with the comment run above it. */
export function sampleSettingsOf(text: string): SampleSetting[] {
  const lines = text.split('\n');
  const settings: SampleSetting[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const key = envKeyIn(line);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    settings.push({
      key,
      value: envValueIn(line) ?? '',
      description: descriptionAbove(lines, index),
    });
  });
  return settings;
}

/**
 * The comment lines directly above a key, joined.
 *
 * A blank line ends the run, so a section header with a gap under it belongs to
 * the section rather than to the key. A commented out assignment is a comment
 * line like any other and stays in the text, because upstream comments a key
 * out to say what the fallback is.
 */
function descriptionAbove(lines: readonly string[], index: number): string {
  const run: string[] = [];
  for (let i = index - 1; i >= 0 && COMMENT_RE.test(lines[i] ?? ''); i -= 1) {
    run.unshift(commentTextIn(lines[i] ?? ''));
  }
  return run.filter((piece) => piece !== '').join(' ');
}

function commentTextIn(line: string): string {
  return line.replace(/\r$/, '').replace(/^\s*#/, '').replace(/^ /, '').trimEnd();
}

/** One key of an env file to assign, or to take out of it. */
export interface EnvEdit {
  key: string;
  value: string;
  remove?: boolean;
}

/**
 * The file with the given keys assigned, removed or appended, and every other
 * byte as it was.
 */
export function rewriteEnvText(text: string, edits: readonly EnvEdit[]): string {
  const byKey = new Map(edits.map((edit) => [edit.key, edit]));
  const found = new Set<string>();
  const kept: string[] = [];

  for (const line of text.split('\n')) {
    const key = envKeyIn(line);
    const edit = key === null ? undefined : byKey.get(key);
    if (!edit) {
      kept.push(line);
      continue;
    }
    found.add(edit.key);
    if (!edit.remove) kept.push(assignedLine(line, edit.value));
  }

  const appended = edits
    .filter((edit) => !edit.remove && !found.has(edit.key))
    .map((edit) => `${edit.key}=${edit.value}`);
  const rewritten = kept.join('\n');
  if (appended.length === 0) return rewritten;

  const separator = rewritten.length > 0 && !rewritten.endsWith('\n') ? '\n' : '';
  return `${rewritten}${separator}${appended.join('\n')}\n`;
}

function assignedLine(line: string, value: string): string {
  const match = ASSIGNMENT_RE.exec(line);
  return match ? `${match[1]}${value}${match[3]}` : line;
}
