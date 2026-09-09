/**
 * That the manager's own deploy ships the manager and nothing of the streaming
 * stack but the commit it pins, and lets the host command decide the rest.
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

import { MANAGER_POSTGRES_VOLUME } from '../../src/domain/versions/managerProject.js';
import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');

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

  it('pins the stack commit from the repository itself, not from a checkout of the submodule', () => {
    assert.match(script, new RegExp(`git rev-parse HEAD:manager/swarm-hls-stream > manager/${STACK_COMMIT_FILE.replace('.', '\\.')}`));
  });

  it('builds nothing of the streaming stack here, because the host fetches and builds it', () => {
    assert.equal(script.includes('pnpm -C manager/swarm-hls-stream'), false, 'the stack is not installed or built on this machine');
    assert.equal(script.includes('bundled:seal'), false, 'nothing is sealed into a package any more');
    assert.equal(script.includes('bundled.packages'), false, 'and no package root is written to');
    assert.equal(script.includes('uuidgen'), false, 'a shipment has no id because there is no shipment');
  });

  it('ships one rsync, the repository, and no package beside it', () => {
    assert.equal(rsyncs().length, 1, 'the repository is the only thing copied to the host');
  });

  it('interpolates no identity it had to check first, because the seal that produced them is gone', () => {
    assert.equal(script.includes('check_identity'), false);
    assert.equal(script.includes('SHIPMENT_ID'), false);
    assert.equal(script.includes('SHIPMENT_DIGEST'), false);
    assert.equal(script.includes('TOOLCHAIN'), false);
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
    // A substitution inside a [ ... ] condition reports what it printed rather than that it
    // failed, so a daemon that is down would read as a host with nothing on it and take the
    // first use branch.
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

  it('gives the upgrade the identity of the manager, of the image and how long to wait for the bundled build', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of ['--manager-commit', '--manager-digest', '--image-id', '--project manager',
      '--compose-file', '--mutable-root', '--bundled-timeout']) {
      assert.ok(upgrade.includes(flag), `the upgrade is given ${flag}`);
    }
    assert.match(script, /IMAGE_ID="\\\$\(docker image inspect --format '\{\{\.Id\}\}' manager-api\)"/);
  });

  it('gives the upgrade no shipment, because the host builds the stack itself', () => {
    const upgrade = script.slice(script.indexOf('manager:upgrade'));
    for (const flag of ['--shipment-id', '--commit ', '--digest ', '--toolchain']) {
      assert.equal(upgrade.includes(flag), false, `the upgrade is not given ${flag}`);
    }
  });

  it('lets the deployer say how long the bundled build may take, with a default of its own', () => {
    assert.match(script, /BUNDLED_TIMEOUT="\$\{BUNDLED_TIMEOUT:-\d+\}"/);
  });

  it('refuses a bundled timeout that is not whole seconds, before it reaches the remote quoting', () => {
    const assignment = script.indexOf('BUNDLED_TIMEOUT="${BUNDLED_TIMEOUT:-');
    const checked = script.indexOf('if ! [[ "$BUNDLED_TIMEOUT" =~ ^[0-9]+$ ]]');
    assert.notEqual(checked, -1, 'the value lands inside single quotes in the remote heredoc');
    assert.ok(checked > assignment, 'after the value is settled');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before anything runs on the host');
  });

  it('feeds both remote docker commands from /dev/null, so neither reads the rest of the script', () => {
    // The remote block arrives on the stdin of one bash, and `run` and `exec` keep stdin open,
    // so without this the lines below them are swallowed instead of run.
    const run = script.slice(script.indexOf('docker compose run --rm --no-deps -T api'));
    const closed = run.indexOf(')"');
    assert.notEqual(closed, -1, 'the substitution that captures the receipt ends somewhere');
    assert.match(run.slice(0, closed + 2), /\$\{PUBLIC_EDGE_FLAG\} < \/dev\/null\)"$/,
      'the upgrade takes the edge decision and no standard input');
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

  it('lets an address probe that answered nothing through, so the warning below it is reached', () => {
    // The remote block runs under set -e with pipefail, so a failing pipe inside this
    // substitution would end it here and the warning, the upgrade and the receipt would never run.
    const line = script.split('\n').find((one) => one.startsWith('PUBLIC_HOST="'));
    assert.ok(line, 'the remote block reads the address of the host');
    assert.match(line, /\|\| true\)"$/);
    assert.ok(script.indexOf('WARNING: PUBLIC_HOST is empty') > script.indexOf('PUBLIC_HOST="'), 'and says so below it');
  });

  it('looks for the same data volume the upgrade names, so a rename on one side fails here', () => {
    // The script cannot import TypeScript, so its one literal is read back against the
    // constant the command uses and the two are changed together.
    assert.ok(script.includes(`POSTGRES_VOLUME="manager_${MANAGER_POSTGRES_VOLUME}"`),
      `the deploy names the manager_${MANAGER_POSTGRES_VOLUME} volume of the manager project`);
  });

  it('never asks compose to print a rendered configuration', () => {
    for (const match of script.matchAll(/docker compose[^\n]*\bconfig\b[^\n]*/g)) {
      assert.match(match[0], /--quiet/, 'a rendered compose file would carry the values of every secret');
    }
  });

  it('names the versions root on the host, which is where the bundled build lands', () => {
    assert.ok(script.includes('streaming-infra-manager-versions'), 'the remote block exports it');
  });
});
