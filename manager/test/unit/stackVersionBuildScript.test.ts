/**
 * That the build container is shown the staging tree and nothing else, and
 * that an attempt is its own.
 *
 * Every deployment's secrets live in a version's flat root as `.env.<profile>`,
 * with STREAM_KEY, SRT_PASSPHRASE and STAMP in them, and the base `.env`
 * alongside. The build runs the followed branch's own install and build
 * scripts inside a container, so mounting that root, or the clone, would hand
 * a branch nobody vetted what is there. The script exports the fetched commit
 * into the attempt's staging tree, mounts that, and leaves the tree for the
 * manager to publish.
 *
 * Read from the file, as `nginxProxyHeaders.test.ts` reads nginx.conf: none of
 * this can be exercised without git, docker and a network.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILD_CONTAINER_PREFIX,
  BUILD_IMAGE,
  PINNED_PNPM,
  STACK_COMMIT_FILE,
} from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = join(here, '..', '..', 'scripts', 'stack-version-build.sh');

const script = readFileSync(BUILD_SCRIPT, 'utf8');

/**
 * The `docker run ...` invocation, up to the image name. Matched at the start
 * of a line, because the script's own header talks about `docker run -v` too.
 */
function dockerRun(): string {
  const start = script.indexOf('\ndocker run');
  assert.notEqual(start, -1, 'no docker run in the build script');

  const end = script.indexOf('$BUILD_IMAGE', start);
  assert.notEqual(end, -1, 'the docker run does not reach the build image');
  return script.slice(start, end);
}

describe('stack-version-build.sh mounts', () => {
  it('gives the build container the staging tree', () => {
    assert.match(dockerRun(), /-v "\$STAGING:\$STAGING"/);
    assert.match(dockerRun(), /-w "\$STAGING"/);
  });

  it('never gives it the clone, and knows no flat root at all', () => {
    assert.equal(dockerRun().includes('$REPO'), false, 'the clone is mounted into the build container');
    assert.equal(script.includes('$ROOT'), false, 'the script names a flat root');
  });

  it('exports the fetched commit rather than copying the working tree', () => {
    assert.match(script, /git -C "\$REPO" archive "\$ARCHIVE_REV" \| tar -x -C "\$STAGING"/);
  });

  it('caps what the build may spend on this host', () => {
    assert.match(dockerRun(), /--memory 4g/);
    assert.match(dockerRun(), /--cpus 2/);
    assert.match(dockerRun(), /--pids-limit 512/);
  });

  it('passes no environment of its own into the container', () => {
    assert.equal(dockerRun().includes('-e '), false);
    assert.equal(dockerRun().includes('--env'), false);
  });

  it('builds with the image and the pnpm the manager records in every manifest', () => {
    assert.match(script, new RegExp(`BUILD_IMAGE="${BUILD_IMAGE}"`));
    assert.match(script, new RegExp(`PINNED_PNPM='${PINNED_PNPM}'`));
  });
});

describe('stack-version-build.sh attempts', () => {
  it('names the build container after the attempt, so boot can ask Docker whether it still runs', () => {
    assert.match(dockerRun(), new RegExp(`--name "${BUILD_CONTAINER_PREFIX}\\$ATTEMPT"`));
    assert.match(script, /\[\[ "\$ATTEMPT" =~ \^\[0-9a-f\]\{8,32\}\$ \]\]/);
  });

  it('refuses a staging tree that exists, because an attempt never shares one', () => {
    assert.match(script, /if \[ -e "\$STAGING" \]; then/);
  });

  it('leaves the commit it exported in the staging tree for the manager', () => {
    assert.match(script, new RegExp(`> "\\$STAGING/${STACK_COMMIT_FILE.replace('.', '\\.')}"`));
  });

  it('removes its staging tree on failure and leaves it on success', () => {
    assert.match(script, /if \[ "\$code" -ne 0 \]; then rm -rf "\$STAGING"; fi/);
  });

  it('copies nothing back and publishes nothing: that is the manager\'s', () => {
    assert.equal(script.includes('rsync'), false);
    assert.equal(script.includes('copy_when_missing'), false);
  });
});

describe('stack-version-build.sh refs', () => {
  it('takes a forty character commit as well as a branch or a tag', () => {
    assert.match(script, /REF_IS_COMMIT=/, 'the script tells a commit from a name');
    assert.match(script, /\^\[0-9a-f\]\{40\}\$/, 'a commit is forty hex characters');
  });

  it('fetches a commit into an existing clone rather than asking for a branch of that name', () => {
    const existing = script.slice(script.indexOf('if [ -d "$REPO/.git" ]'), script.indexOf('COMMIT="$(git -C'));
    assert.match(existing, /git -C "\$REPO" fetch --prune origin "\$REF"/, 'a commit is fetched without --tags');
    assert.match(existing, /git -C "\$REPO" checkout --detach --force FETCH_HEAD/);
    assert.match(existing, /git -C "\$REPO" reset --hard FETCH_HEAD/);
  });

  it('makes an empty clone and fetches the commit into it, because clone --branch takes no commit', () => {
    const fresh = script.slice(script.indexOf('git init'), script.indexOf('COMMIT="$(git -C'));
    assert.match(fresh, /git init/);
    assert.match(fresh, /git -C "\$REPO" remote add origin "\$REPO_URL"/);
    assert.match(fresh, /git -C "\$REPO" fetch origin "\$REF"/);
    assert.match(fresh, /git -C "\$REPO" checkout --detach --force FETCH_HEAD/);
  });

  it('keeps the clone of a branch or a tag as it was', () => {
    assert.match(script, /git clone --branch "\$REF" --single-branch "\$REPO_URL" "\$REPO"/);
    assert.match(script, /git -C "\$REPO" fetch --prune --tags origin "\$REF"/);
  });
});

/**
 * The commit path run for real, against a repository on this disk and a docker
 * that does nothing. Only git runs: the fetch, the detached checkout and the
 * export are the part of this script no reading of its text can prove.
 *
 * The script may only be given the stack's own https url, so the local
 * repository is put behind that url with git's own `insteadOf` rewrite in a
 * home directory of this test's making. Nothing of the script is relaxed for
 * the test, and nothing leaves this machine.
 */
describe('stack-version-build.sh fetches a pinned commit', () => {
  const STACK_URL = 'https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git';
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=build@example.invalid', '-c', 'user.name=Build', ...args], { cwd, encoding: 'utf8' }).trim();

  /** An origin with two commits, a docker that does nothing, and a home that points the stack url here. */
  function fixture(root: string): { pinned: string; environment: NodeJS.ProcessEnv } {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    // The one server setting GitHub already has: a reachable commit may be
    // asked for by name, which is what pinning a commit needs.
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(join(origin, 'package.json'), '{"name":"pinned"}\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'first');
    const pinned = git(origin, 'rev-parse', 'HEAD');
    writeFileSync(join(origin, 'package.json'), '{"name":"moved-on"}\n');
    git(origin, 'commit', '-qam', 'second');

    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), `[url "${origin}"]\n\tinsteadOf = ${STACK_URL}\n`);

    return { pinned, environment: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH ?? ''}` } };
  }

  function build(root: string, repo: string, ref: string, environment: NodeJS.ProcessEnv): string {
    const staging = join(root, `staging-${ref.slice(0, 8)}`);
    execFileSync('bash', [BUILD_SCRIPT, repo, staging, ref, STACK_URL, 'abcdef01'], { env: environment });
    return staging;
  }

  it('fetches it into a clone the version already has', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-commit-'));
    try {
      const { pinned, environment } = fixture(root);
      const repo = join(root, 'stack.repo');
      execFileSync('git', ['clone', '-q', join(root, 'origin'), repo]);

      const staging = build(root, repo, pinned, environment);

      assert.equal(readFileSync(join(staging, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"name":"pinned"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches it into a clone that does not exist yet, where clone --branch would refuse a commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-build-fresh-'));
    try {
      const { pinned, environment } = fixture(root);

      const staging = build(root, join(root, 'stack.repo'), pinned, environment);

      assert.equal(readFileSync(join(staging, STACK_COMMIT_FILE), 'utf8').trim(), pinned);
      assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"name":"pinned"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
