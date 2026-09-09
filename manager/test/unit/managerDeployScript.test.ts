/**
 * That the manager's own deploy seals what it ships, ships it where the host
 * publishes it from, and lets the host command decide the rest.
 *
 * Read from the file, the way the build script is read: the deploy needs a
 * host, a network and a signing key. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');
const PACKAGES_DIR = 'bundled.packages';
const SEALED = 'sealed-${SHIPMENT_ID}';

const script = readFileSync(DEPLOY_SCRIPT, 'utf8');

/** Every `rsync ...` invocation, each up to its destination line. */
function rsyncs(): string[] {
  return script.split(/\n(?=rsync )/).filter((block) => block.startsWith('rsync ')).map((block) => block.split('\n\n')[0] ?? block);
}

describe('deploy/deploy.sh', () => {
  it('is a script bash accepts', () => {
    execFileSync('bash', ['-n', DEPLOY_SCRIPT]);
  });

  it('leaves the bundled tree the engines mount out of the rsync that deletes into the repo', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${REMOTE_PATH}/"'));
    assert.ok(repo, 'the rsync into the repository');
    assert.match(repo, /--delete/);
    assert.match(repo, /--exclude 'manager\/swarm-hls-stream\/'/);
  });

  it('has nothing left of the staging tree the api used to publish at boot', () => {
    assert.equal(script.includes('bundled.incoming'), false);
  });

  it('still writes the stack commit next to the checkout, which a row never published reads', () => {
    assert.match(script, new RegExp(`${STACK_COMMIT_FILE.replace('.', '\\.')}`));
  });

  it('seals the built stack into a package, adopting the host inputs and taking both built directories', () => {
    const called = script.indexOf('cli.js bundled:seal');
    assert.notEqual(called, -1, 'the deploy seals what it ships');
    const seal = script.slice(called, called + 600);
    assert.match(seal, /--source manager\/swarm-hls-stream/);
    assert.match(seal, /--shipment-id "\$SHIPMENT_ID"/);
    assert.match(seal, /--dist packages\/client\/dist/);
    assert.match(seal, /--dist packages\/stream-uploader\/dist/);
    assert.match(seal, /--adopt-inputs/);
    assert.match(seal, /--toolchain/);
  });

  it('makes one shipment id per deploy rather than replaying an old one', () => {
    assert.match(script, /SHIPMENT_ID="\$\(uuidgen/);
  });

  it('ships the sealed package into a staging name under the packages root, keeping modes and links', () => {
    assert.match(script, new RegExp(`REMOTE_PACKAGES="\\$\\{REMOTE_VERSIONS_ROOT\\}/${PACKAGES_DIR}"`), 'the packages root is one directory of its own');
    const shipment = rsyncs().find((block) => block.includes(`\${REMOTE_PACKAGES}/${SEALED}.tmp/`));
    assert.ok(shipment, 'the rsync of the sealed package');
    assert.match(shipment, /rsync -a /, 'archive mode, so modes and symbolic links survive');
    assert.match(shipment, /--delete/);
  });

  it('renames the staging name to the sealed one after the last rsync, so the host never reads a torn package', () => {
    const promote = script.indexOf(`mv '\${REMOTE_PACKAGES}/${SEALED}.tmp' '\${REMOTE_PACKAGES}/${SEALED}'`);
    assert.notEqual(promote, -1, 'the rename that makes the package visible');
    assert.ok(promote > script.lastIndexOf('\nrsync '), 'nothing is visible to the host before the last rsync finished');
  });

  it('builds the image on the host and then runs the upgrade from it, not from the running api', () => {
    const build = script.indexOf('docker compose build');
    const upgrade = script.indexOf('docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade');
    assert.notEqual(build, -1, 'the image is built on the host');
    assert.notEqual(upgrade, -1, 'the upgrade runs in a container of the image just built');
    assert.ok(build < upgrade, 'the image exists before the upgrade runs from it');
  });

  it('decides on the host whether this manager has ever run here, before the one-off container exists', () => {
    const run = script.indexOf('docker compose run --rm --no-deps -T api');
    assert.notEqual(run, -1, 'the upgrade runs in a one-off container');
    const before = script.slice(0, run);
    assert.ok(before.includes('docker volume ls -q --filter name=^\\${POSTGRES_VOLUME}\\$'), 'the data volume is looked for by name');
    assert.ok(before.includes('service_containers api'), 'so are the api containers of the project');
    assert.ok(before.includes('service_containers postgres'), 'and the postgres ones');
    assert.match(before, /label=com\.docker\.compose\.oneoff=False/, 'neither count a one-off container');
  });

  it('reads each probe into a variable of its own, where a docker that could not be asked stops the deploy', () => {
    // Inside a test the shell reports what the substitution answered, not that it failed, so a
    // daemon that is down would read as a host with nothing on it and take the first use branch.
    const before = script.slice(0, script.indexOf('docker compose run --rm --no-deps -T api')).split('\n');
    for (const probe of ['docker volume ls -q --filter name=', 'service_containers api', 'service_containers postgres']) {
      const asked = before.filter((line) => line.includes(probe));
      assert.equal(asked.length, 1, `${probe} is asked in one place`);
      assert.match(asked[0]!.trim(), /^[A-Z_]+="\\\$\(/, `${probe} is read into a variable of its own`);
    }
  });

  it('stops before the upgrade when the data volume went missing under an installed manager', () => {
    const abort = script.indexOf('so its database was removed under a manager that is still installed');
    assert.notEqual(abort, -1, 'the deploy says what it found');
    assert.ok(abort < script.indexOf('docker compose run --rm --no-deps -T api'), 'and says it before anything is published');
    assert.match(script.slice(abort, abort + 300), /exit 1/, 'the deploy stops there');
  });

  it('hands the first use answer to the upgrade rather than letting it probe from inside', () => {
    assert.match(script, /FIRST_USE_FLAG="--first-use"/, 'the flag is set where the probes said so');
    const upgrade = script.slice(script.indexOf('cli.js manager:upgrade'));
    assert.ok(upgrade.includes('\\${FIRST_USE_FLAG}'), 'and reaches the command');
  });

  it('gives the upgrade the identity of the shipment, of the manager and of the image', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of ['--shipment-id', '--commit', '--digest', '--manager-commit', '--manager-digest',
      '--image-id', '--project manager', '--compose-file', '--mutable-root', '--toolchain']) {
      assert.ok(upgrade.includes(flag), `the upgrade is given ${flag}`);
    }
    assert.match(script, /IMAGE_ID="\\\$\(docker image inspect --format '\{\{\.Id\}\}' manager-api\)"/);
  });

  it('feeds both remote docker commands from /dev/null, so neither reads the rest of the script', () => {
    // The remote block arrives on the stdin of one bash, and `run` and `exec` keep stdin open,
    // so without this the lines below them are swallowed instead of run.
    const run = script.slice(script.indexOf('docker compose run --rm --no-deps -T api'));
    const closed = run.indexOf(')"');
    assert.notEqual(closed, -1, 'the substitution that captures the receipt ends somewhere');
    assert.match(run.slice(0, closed + 2), /--toolchain '\$\{TOOLCHAIN\}' \$\{PUBLIC_EDGE_FLAG\} < \/dev\/null\)"$/,
      'the upgrade takes the toolchain, the edge decision and no standard input');
    assert.match(script, /docker compose exec -T api [^\n]* < \/dev\/null/, 'and neither does the check that follows it');
  });

  it('asks for the public edge only where the domain says so', () => {
    const branch = script.indexOf('COMPOSE_PROFILE_FLAG=""');
    assert.equal(script.split('--public-edge').length - 1, 1, 'the flag is decided in one place');
    const decision = script.indexOf('PUBLIC_EDGE_FLAG="--public-edge"');
    assert.notEqual(decision, -1, 'the public branch sets it');
    assert.ok(decision > script.indexOf('elif [[ "$MANAGER_DOMAIN" =~ $HOSTNAME_PATTERN ]]'), 'inside the branch that saw a host name');
    assert.ok(decision < script.indexOf('\nelse\n', script.indexOf('elif [[ "$MANAGER_DOMAIN"')), 'and not below it');
    assert.equal(branch, -1, 'the old compose profile flag is gone');
  });

  it('prints the receipt the upgrade returned, after the command that returned it', () => {
    const captured = script.indexOf('RECEIPT="\\$(docker compose run --rm --no-deps -T api node dist/cli.js manager:upgrade');
    assert.notEqual(captured, -1, 'the receipt is the one line the upgrade printed');
    const printed = script.indexOf('echo "[deploy] upgrade receipt: \\${RECEIPT}"');
    assert.notEqual(printed, -1, 'and the deploy prints it as it stands');
    assert.ok(printed > captured, 'after the command that returned it, never before');
  });

  it('checks the seal output and every identity it interpolates, before any of it reaches the host', () => {
    const remote = script.indexOf('ssh "$SSH_TARGET" bash -s');
    assert.notEqual(remote, -1, 'the remote block');
    const before = script.slice(0, remote);
    assert.match(before, /node -e/, 'one node run reads the JSON the seal printed and can refuse it');
    assert.match(before, /printed no/, 'and names the field a line without one is missing');
    for (const name of ['SHIPMENT_ID', 'SHIPMENT_COMMIT', 'SHIPMENT_DIGEST', 'MANAGER_COMMIT', 'MANAGER_DIGEST']) {
      assert.ok(before.includes(`check_identity "${name}"`), `${name} is checked before it is interpolated`);
    }
    assert.match(before, /\[0-9a-f\]\{8\}-/, 'the shipment id is a uuid');
    assert.match(before, /\[a-f0-9\]\{40\}\$/, 'a commit is forty hex characters');
    assert.match(before, /\[a-f0-9\]\{64\}\$/, 'a digest is sixty four');
  });

  it('never asks compose to print a rendered configuration', () => {
    for (const match of script.matchAll(/docker compose[^\n]*\bconfig\b[^\n]*/g)) {
      assert.match(match[0], /--quiet/, 'a rendered compose file would carry the values of every secret');
    }
  });

  it('names one versions root on both sides', () => {
    const named = script.match(/streaming-infra-manager-versions/g) ?? [];
    assert.ok(named.length >= 2, 'the laptop side and the host side both name it');
  });
});
