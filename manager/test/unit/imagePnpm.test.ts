/**
 * Which pnpm the api and web images install with, read off their Dockerfiles.
 *
 * The lockfile is written by the pnpm the root package.json names in
 * packageManager, and a pnpm of another major reads the lockfile's settings from
 * another place. The web image installed pnpm 9 of its own, which never reads the
 * overrides in pnpm-workspace.yaml, so once those existed its frozen install
 * refused the lockfile and the deploy of v2.2 on 2026-09-25 stopped at the build.
 * The checks workflow's images job builds both images since then. This file names
 * that one cause in the unit suite, where it fails in seconds rather than minutes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DOCKERFILES = {
  api: join(repoRoot, 'manager', 'Dockerfile'),
  web: join(repoRoot, 'frontend', 'Dockerfile'),
} as const;

describe('the images install with the pnpm the repository names', () => {
  for (const [image, path] of Object.entries(DOCKERFILES)) {
    it(`the ${image} image takes pnpm from packageManager through corepack`, () => {
      const dockerfile = readFileSync(path, 'utf8');
      assert.match(dockerfile, /^RUN corepack enable\s*$/m);
      assert.doesNotMatch(dockerfile, /\bnpm\s+(install|i|add)\b[^\n]*\bpnpm\b/, 'no pnpm installed beside it');
    });
  }
});
