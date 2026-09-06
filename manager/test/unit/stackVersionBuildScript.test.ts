/**
 * That the build container is never shown the live checkout.
 *
 * Every deployment's secrets live in a version's root as `.env.<profile>`, with
 * STREAM_KEY, SRT_PASSPHRASE and STAMP in them, and the base `.env` alongside.
 * The build runs the followed branch's own install and build scripts inside a
 * container, so mounting that root would hand a branch nobody vetted every
 * secret on the host. The script exports the fetched commit into a staging tree
 * instead, mounts that, and copies the result back with the env files excluded.
 *
 * Read from the file, as `nginxProxyHeaders.test.ts` reads nginx.conf: none of
 * this can be exercised without git, docker and a network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = join(
  here,
  '..',
  '..',
  'scripts',
  'stack-version-build.sh',
);

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

  it('never gives it the root, where the deployments keep their secrets', () => {
    assert.equal(
      dockerRun().includes('$ROOT'),
      false,
      'the root is mounted into the build container',
    );
  });

  it('exports the fetched commit rather than copying the working tree', () => {
    assert.match(script, /git -C "\$ROOT" archive "\$ARCHIVE_REV" \| tar -x -C "\$STAGING"/);
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

  it('removes the staging tree whether the build passed or failed', () => {
    assert.match(script, /trap 'rm -rf "\$STAGING"' EXIT/);
  });
});

describe('stack-version-build.sh copies back', () => {
  /** The `rsync -a --delete ... "$STAGING/" "$ROOT/"` invocation. */
  const rsync = (): string => {
    const start = script.indexOf('\nrsync -a --delete');
    assert.notEqual(start, -1, 'no rsync in the build script');

    const end = script.indexOf('"$ROOT/"', start);
    assert.notEqual(end, -1, 'the rsync does not end at the root');
    return script.slice(start, end);
  };

  it('lands the built tree in the root the deploy scripts read', () => {
    assert.match(script, /rsync -a --delete[\s\S]*"\$STAGING\/" "\$ROOT\/"/);
  });

  it('keeps every file this host wrote into the root', () => {
    for (const pattern of [
      '.git',
      '.env',
      '.env.*',
      'deploy/config.json',
      'deploy/.env.deploy*',
      'engines/*/.env*',
      'nodes/data',
      'deploy/data',
    ]) {
      assert.equal(
        rsync().includes(`--exclude '${pattern}'`),
        true,
        `${pattern} is not excluded, so --delete would take it`,
      );
    }
  });
});
