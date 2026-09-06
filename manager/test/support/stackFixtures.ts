import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The cut-down checkouts of both branches, read-only. */
export const STACK_FIXTURES = join(here, '..', 'fixtures', 'stack');

export const V2_FIXTURE = join(STACK_FIXTURES, 'v2');
export const V3_FIXTURE = join(STACK_FIXTURES, 'v3');

/**
 * A throwaway versions root holding a copy of the `v3` fixture under the name
 * `v3`, committed to a git repository of its own, so a build reported as
 * successful finds a checkout that can be read for both a contract and a
 * commit. `v3` is therefore the only name a build can succeed under here.
 *
 * A copy rather than the fixture itself, and this is not a detail: removing a
 * version deletes its checkout, so a test pointed at the fixtures deletes them.
 * That is exactly what happened on the first run of the routes test, and the
 * next run failed somewhere else entirely.
 */
export function scratchVersionsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-versions-'));
  const checkout = join(root, 'v3');
  cpSync(V3_FIXTURE, checkout, { recursive: true });
  commitFixture(checkout);
  return root;
}

/** The commit `scratchVersionsRoot` left the copy on. */
export function checkoutCommit(checkout: string): string {
  return git(checkout, ['rev-parse', 'HEAD']);
}

/**
 * Moves the checkout on one commit and answers the new one, standing in for a
 * rebuild whose fetch found the branch somewhere else. Empty, because what the
 * manager reads off a rebuilt checkout is the commit and not the files.
 */
export function advanceCheckout(checkout: string): string {
  git(checkout, [
    'commit',
    '--quiet',
    '--allow-empty',
    '--message',
    'the branch moved',
  ]);
  return checkoutCommit(checkout);
}

/**
 * One commit holding whatever is in the directory. The manager asks git which
 * commit a built version is on, so a fixture that stands in for a built version
 * has to be a git checkout rather than a plain directory of files.
 */
function commitFixture(checkout: string): void {
  git(checkout, ['init', '--quiet', '--initial-branch=main']);
  git(checkout, ['add', '--all']);
  git(checkout, ['commit', '--quiet', '--message', 'fixture']);
}

/**
 * The machine's own git configuration is kept out: a global commit.gpgsign or
 * a required signing key would fail a commit no test asked to sign.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=stack fixtures',
      '-c',
      'user.email=fixtures@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
}
