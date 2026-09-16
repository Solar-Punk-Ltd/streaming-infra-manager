/**
 * The one lockfile the workspace resolves from, and that it is the only one.
 *
 * pnpm keeps a single lockfile at the root of a workspace and never reads one
 * inside a package, so a package-level lockfile is a copy nothing regenerates.
 * frontend/pnpm-lock.yaml sat unchanged from 2026-05-19 while the package
 * gained three dependencies, and Dependabot filed twenty of the repository's
 * sixty alerts against it. It went on 2026-09-16, and this keeps the next one
 * from settling in.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

/** The packages the workspace file lists, one `  - name` line each. */
const packages = [...workspace.matchAll(/^ {2}- (\S+)\s*$/gm)].map((match) => match[1]);

describe('the workspace lockfile', () => {
  it('covers every package the workspace names', () => {
    assert.ok(packages.length > 0, 'the workspace file names its packages the way this test reads them');
    for (const name of packages) {
      assert.ok(existsSync(join(root, name, 'package.json')), `${name} is a package`);
      assert.match(lockfile, new RegExp(`^ {2}${name}:$`, 'm'), `${name} is an importer of the root lockfile`);
    }
  });

  it('is the only one, because pnpm never reads a lockfile inside a package', () => {
    for (const name of packages) {
      assert.equal(existsSync(join(root, name, 'pnpm-lock.yaml')), false, `${name}/pnpm-lock.yaml is a stale copy nothing regenerates`);
    }
  });
});
