/**
 * Every mount of a file the build carries goes into its engine container read
 * only, because writing one would write the published build.
 *
 * A deployment runs from a private copy of its build whose regular files are
 * hard links of the build's own inodes, so a container that could write one of
 * them would change the published build through the link, and every later
 * deploy of that build would be refused against the inventory record taken of
 * it. Read only is what keeps that from happening, and nothing asserted it.
 *
 * The compose files read here live in the swarm-hls-stream submodule, which
 * moves on its own schedule, at the commit this repository pins:
 * `engines/*` and `deploy/*` docker-compose files, which today are
 * engines/srs/docker-compose.yml, engines/ome/docker-compose.yml and the five
 * under deploy/. A new engine directory is picked up without changing this
 * file, and a mount of a build file that stops being read only fails here.
 *
 * Unit test, no database, no Docker and no network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const STACK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'swarm-hls-stream');

/** One bind mount, as the compose file writes it. */
interface Mount {
  file: string;
  line: string;
  source: string;
  readOnly: boolean;
}

/** A mount whose source is a file of the build, named by that file's path in the stack tree. */
interface BuildFileMount extends Mount {
  path: string;
}

/**
 * What a compose variable falls back to when nothing sets it, unwrapped as far
 * as it nests, or the path itself when it is a literal. A variable with no
 * default names something outside the tree and cannot be resolved here.
 */
function defaultOf(source: string): string | null {
  const wrapped = /^\$\{[A-Z0-9_]+:-([\s\S]*)\}$/.exec(source.trim());
  if (wrapped) return defaultOf(wrapped[1]!);
  return source.includes('${') || source === '' ? null : source;
}

/**
 * The source, target and mode of one bind mount.
 *
 * Splitting on every colon is wrong: a source may hold one inside a
 * `${VAR:-default}`, and nesting one default in another holds two more.
 */
function fieldsOf(entry: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of entry) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (char === ':' && depth === 0) { fields.push(current); current = ''; continue; }
    current += char;
  }
  return [...fields, current];
}

function mountsIn(file: string): Mount[] {
  const mounts: Mount[] = [];
  let inVolumes = false;
  for (const line of readFileSync(join(STACK, file), 'utf8').split('\n')) {
    if (/^\s*volumes:\s*$/.test(line)) { inVolumes = true; continue; }
    const item = /^\s*-\s+'?([^'\n]+?)'?\s*$/.exec(line);
    if (!inVolumes || !item) { if (/^\s*\w[\w-]*:/.test(line)) inVolumes = false; continue; }
    const fields = fieldsOf(item[1]!);
    if (fields.length < 2) continue;
    mounts.push({ file, line: line.trim(), source: fields[0]!, readOnly: fields.length > 2 && fields[fields.length - 1] === 'ro' });
  }
  return mounts;
}

function composeFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(STACK, directory), { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) found.push(...composeFilesUnder(path));
    else if (/^docker-compose.*\.ya?ml$/.test(name.name)) found.push(path);
  }
  return found;
}

/** The mounts whose source is a file the build carries, which are the ones that are hard links of it. */
function mountsOfBuildFiles(): BuildFileMount[] {
  const files = [...composeFilesUnder('engines'), ...composeFilesUnder('deploy')];
  assert.ok(files.length > 0, 'no compose file was found in the stack tree, so this test proves nothing');
  return files.flatMap(mountsIn).flatMap((mount) => {
    const fallback = defaultOf(mount.source);
    if (fallback === null) return [];
    const path = resolve(STACK, dirname(mount.file), fallback);
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    return [{ ...mount, path: relative(STACK, path) }];
  });
}

describe('what an engine container mounts out of a deployment copy', () => {
  it('is read only for every file the build carries, so no container can write the published build', () => {
    for (const mount of mountsOfBuildFiles()) {
      assert.ok(mount.readOnly,
        `${mount.file} mounts a file of the build without :ro (${mount.line}). ` +
        'That file is a hard link of the published build, so a container writing it writes the build, ' +
        'and every later deploy of that build is refused against its inventory record.');
    }
  });

  it('reads a mount that is not read only as one, so the check above can fail', () => {
    // The media directory is the writable mount, and it is a directory the deployment makes rather than a file the build carries.
    const writable = composeFilesUnder('engines').flatMap(mountsIn).filter(mount => !mount.readOnly);

    assert.ok(writable.length > 0,
      'every mount in the engines parsed as read only, so the check above passes whatever the compose files say. ' +
      'If the stack really made them all read only, put a synthetic line through mountsIn here instead.');
    for (const mount of writable) {
      const fallback = defaultOf(mount.source);
      assert.ok(fallback === null || !existsSync(resolve(STACK, dirname(mount.file), fallback)),
        `${mount.file} mounts something that is in the build tree and is not read only: ${mount.line}`);
    }
  });

  it('still covers the engine templates and entrypoints, so a rename cannot empty this check', () => {
    const covered = [...new Set(mountsOfBuildFiles().map(mount => mount.path))].sort();

    assert.deepEqual(covered, [
      'engines/ome/Server.xml.template',
      'engines/ome/entrypoint.sh',
      'engines/srs/entrypoint.sh',
      'engines/srs/healthcheck.sh',
      'engines/srs/srs.conf.template',
    ], 'the set of build files mounted into a container moved. Read the diff, then record the new set here.');
  });
});
