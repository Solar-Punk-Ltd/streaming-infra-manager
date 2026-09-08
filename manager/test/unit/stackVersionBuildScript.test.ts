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
import { readFileSync } from 'node:fs';
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
