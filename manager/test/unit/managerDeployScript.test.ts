/**
 * That the manager's own deploy ships the manager and nothing of the streaming
 * stack but the commit it pins, and lets the host command decide the rest.
 *
 * Read from the file, the way the build script is read: the deploy needs a
 * host, a network and a signing key. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { STACK_COMMIT_FILE } from '../../src/domain/versions/StackVersionService.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_ENTRY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy.sh');
const DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy-managed.sh');
const STANDALONE_DEPLOY_SCRIPT = join(here, '..', '..', '..', 'deploy', 'deploy-standalone.sh');
const RELEASE_MODE_SCRIPT = join(here, '..', '..', '..', 'deploy', 'release-mode.sh');
const ADAPTER_SCRIPT = join(here, '..', '..', '..', 'deploy', 'release-adapters', 'manager.sh');
const COMPOSE_FILE = join(here, '..', '..', 'docker-compose.yml');

const script = readFileSync(DEPLOY_SCRIPT, 'utf8');
const adapter = readFileSync(ADAPTER_SCRIPT, 'utf8');
const composeFile = readFileSync(COMPOSE_FILE, 'utf8');
const execFileAsync = promisify(execFile);

/** Every `rsync ...` invocation, each up to its destination line. */
function rsyncs(): string[] {
  return script.split(/\n(?=rsync )/).filter((block) => block.startsWith('rsync ')).map((block) => block.split('\n\n')[0] ?? block);
}

interface ReleaseDispatchFixture {
  calls: string;
  deployRoot: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  home: string;
}

function releaseDispatchFixture(t: { after(callback: () => void): void }): ReleaseDispatchFixture {
  const root = mkdtempSync(join(tmpdir(), 'manager-release-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployRoot = join(root, 'repo', 'deploy');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const calls = join(root, 'calls');
  mkdirSync(deployRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const entry = join(deployRoot, 'deploy.sh');
  writeFileSync(entry, readFileSync(DEPLOY_ENTRY_SCRIPT));
  chmodSync(entry, 0o700);
  const releaseMode = join(deployRoot, 'release-mode.sh');
  writeFileSync(releaseMode, readFileSync(join(dirname(DEPLOY_ENTRY_SCRIPT), 'release-mode.sh')));
  chmodSync(releaseMode, 0o700);
  for (const name of ['deploy-standalone.sh', 'deploy-managed.sh']) {
    const path = join(deployRoot, name);
    writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' '${name}' > '${calls}'\n`);
    chmodSync(path, 0o700);
  }
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, '#!/bin/bash\nshift\nexec "$@"\n');
  chmodSync(ssh, 0o700);
  return {
    calls,
    deployRoot,
    entry,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
    home,
  };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function installFakeGuard(home: string, status: string, exitCode = 0, withState = true): void {
  const bin = join(home, '.local', 'bin');
  const state = join(home, '.local', 'state', 'streaming-release-guard');
  mkdirSync(bin, { recursive: true });
  if (withState) mkdirSync(state, { recursive: true });
  const guard = join(bin, 'streaming-release-guard');
  writeFileSync(guard, `#!/bin/bash
set -euo pipefail
state_root='${state}'
owner_token='22222222-2222-4222-8222-222222222222'
case "\${1:-}" in
  begin-legacy)
    if [ '${exitCode}' -ne 0 ]; then exit '${exitCode}'; fi
    if [ '${status}' = managed ]; then printf '%s\\n' managed; exit 0; fi
    if [ '${status}' != legacy ]; then printf '%s\\n' '${status}'; exit 0; fi
    mkdir "\${state_root}/state.lock"
    printf '%s\\n' "\${owner_token}" > "\${state_root}/state.lock/owner"
    printf 'legacy:%s\\n' "\${owner_token}"
    ;;
  finish-legacy)
    rm -f "\${state_root}/state.lock/owner"
    rmdir "\${state_root}/state.lock"
    ;;
  *) exit 2 ;;
esac
`);
  chmodSync(guard, 0o700);
}

describe('deploy/deploy.sh', () => {
  it('is a script bash accepts', () => {
    execFileSync('bash', ['-n', DEPLOY_ENTRY_SCRIPT]);
    execFileSync('bash', ['-n', DEPLOY_SCRIPT]);
    execFileSync('bash', ['-n', STANDALONE_DEPLOY_SCRIPT]);
  });

  it('acquires and releases the pristine-host lease without host Node', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'manager-release-no-node-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    mkdirSync(bin);
    mkdirSync(home);
    for (const command of ['chmod', 'dirname', 'ln', 'mkdir', 'mv', 'rm', 'rmdir', 'sync', 'tr', 'uname', 'uuidgen']) {
      symlinkSync(execFileSync('which', [command], { encoding: 'utf8' }).trim(), join(bin, command));
    }
    const env = { ...process.env, HOME: home, PATH: bin };

    const begin = await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'begin'], { env });
    assert.match(begin.stdout, /^bootstrap:[0-9a-f-]{36}\n$/);
    const ownerToken = begin.stdout.trim().slice('bootstrap:'.length);
    await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'finish-bootstrap', ownerToken], { env });

    assert.equal(existsSync(join(home, '.local/state/streaming-release-bootstrap.lock')), false);
    assert.doesNotMatch(readFileSync(RELEASE_MODE_SCRIPT, 'utf8'), /\bnode\b/);
  });

  it('cannot release a successor after a duplicate bootstrap finish pauses after reading the owner', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'manager-release-finish-race-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const wrappers = join(root, 'wrappers');
    const ready = join(root, 'ready');
    const resume = join(root, 'resume');
    mkdirSync(home);
    mkdirSync(wrappers);
    for (const command of ['ln', 'rm']) {
      const path = join(wrappers, command);
      writeFileSync(path, `#!/bin/bash
set -euo pipefail
if [ ! -e '${ready}' ]; then
  /usr/bin/touch '${ready}'
  while [ ! -e '${resume}' ]; do /bin/sleep 0.01; done
fi
exec /bin/${command} "$@"
`);
      chmodSync(path, 0o700);
    }
    const env = { ...process.env, HOME: home };
    const first = await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'begin'], { env });
    const firstOwner = first.stdout.trim().slice('bootstrap:'.length);
    const paused = spawn('/bin/bash', [RELEASE_MODE_SCRIPT, 'finish-bootstrap', firstOwner], {
      env: { ...env, PATH: `${wrappers}:${process.env.PATH ?? ''}` },
      stdio: 'ignore',
    });
    t.after(() => { if (paused.exitCode === null) paused.kill('SIGKILL'); });
    await waitForPath(ready);

    await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'finish-bootstrap', firstOwner], { env });
    const successor = await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'begin'], { env });
    const successorOwner = successor.stdout.trim().slice('bootstrap:'.length);
    writeFileSync(resume, 'continue\n');
    const pausedExit = await new Promise<number | null>((resolveClose) => paused.once('close', resolveClose));

    assert.notEqual(pausedExit, 0);
    assert.equal(
      readFileSync(join(home, '.local/state/streaming-release-bootstrap.lock', 'owner'), 'utf8').trim(),
      successorOwner,
    );
    await execFileAsync('/bin/bash', [RELEASE_MODE_SCRIPT, 'finish-bootstrap', successorOwner], { env });
  });

  it('dispatches only a pristine installation to the standalone deploy path', async (t) => {
    const fixture = releaseDispatchFixture(t);

    await execFileAsync(fixture.entry, ['fixture-host'], { env: fixture.env });

    assert.equal(readFileSync(fixture.calls, 'utf8'), 'deploy-standalone.sh\n');
  });

  it('dispatches a valid activated installation to the guarded deploy path', async (t) => {
    const fixture = releaseDispatchFixture(t);
    installFakeGuard(fixture.home, 'managed');

    await execFileAsync(fixture.entry, ['fixture-host'], { env: fixture.env });

    assert.equal(readFileSync(fixture.calls, 'utf8'), 'deploy-managed.sh\n');
  });

  it('keeps a valid installed but unactivated guard on the standalone deploy path', async (t) => {
    const fixture = releaseDispatchFixture(t);
    installFakeGuard(fixture.home, 'legacy');

    await execFileAsync(fixture.entry, ['fixture-host'], { env: fixture.env });

    assert.equal(readFileSync(fixture.calls, 'utf8'), 'deploy-standalone.sh\n');
  });

  it('holds the absent-install bootstrap lease across standalone mutation', async (t) => {
    const fixture = releaseDispatchFixture(t);
    const started = join(fixture.home, 'standalone-started');
    const release = join(fixture.home, 'standalone-release');
    writeFileSync(join(fixture.deployRoot, 'deploy-standalone.sh'), `#!/bin/bash
set -euo pipefail
touch '${started}'
while [ ! -e '${release}' ]; do sleep 0.01; done
printf '%s\n' deploy-standalone.sh > '${fixture.calls}'
`);
    chmodSync(join(fixture.deployRoot, 'deploy-standalone.sh'), 0o700);
    const child = spawn(fixture.entry, ['fixture-host'], { env: fixture.env, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await waitForPath(started);

    await assert.rejects(
      execFileAsync(join(fixture.deployRoot, 'release-mode.sh'), ['begin-bootstrap-install'], {
        env: fixture.env,
      }),
      /bootstrap lease is active/,
    );
    writeFileSync(release, 'release\n');
    const exitCode = await new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
    assert.equal(exitCode, 0);
    assert.equal(existsSync(join(fixture.home, '.local/state/streaming-release-bootstrap.lock')), false);
  });

  it('preserves the bootstrap lease after an ambiguous standalone failure', async (t) => {
    const fixture = releaseDispatchFixture(t);
    writeFileSync(join(fixture.deployRoot, 'deploy-standalone.sh'), '#!/bin/bash\nexit 42\n');
    chmodSync(join(fixture.deployRoot, 'deploy-standalone.sh'), 0o700);

    await assert.rejects(execFileAsync(fixture.entry, ['fixture-host'], { env: fixture.env }));

    assert.equal(
      existsSync(join(fixture.home, '.local/state/streaming-release-bootstrap.lock', 'owner')),
      true,
    );
  });

  it('does not require receipt credentials on the standalone path', () => {
    const standalone = readFileSync(STANDALONE_DEPLOY_SCRIPT, 'utf8');
    assert.doesNotMatch(standalone, /RELEASE_GUARD_ADMIN_(?:URL|TOKEN)/);
    assert.match(script, /RELEASE_GUARD_ADMIN_URL/);
    assert.match(script, /RELEASE_GUARD_ADMIN_TOKEN/);
  });

  it('refuses partial, invalid, and unexpected guard state without dispatching', async (t) => {
    for (const setup of [
      (home: string) => mkdirSync(join(home, '.local', 'state', 'streaming-release-guard'), { recursive: true }),
      (home: string) => installFakeGuard(home, 'legacy', 0, false),
      (home: string) => installFakeGuard(home, 'broken', 1),
      (home: string) => installFakeGuard(home, 'unexpected'),
    ]) {
      const fixture = releaseDispatchFixture(t);
      setup(fixture.home);
      await assert.rejects(execFileAsync(fixture.entry, ['fixture-host'], { env: fixture.env }));
      assert.throws(() => readFileSync(fixture.calls, 'utf8'));
    }
  });

  it('stages a new sibling candidate and never rsyncs over the live manager tree', () => {
    const [repo] = rsyncs();
    assert.ok(repo);
    assert.match(script, /RELEASES_ROOT="\/home\/solarpunk\/streaming-infra-manager-releases\/manager"/);
    assert.match(script, /INCOMING_ROOT="\$\{RELEASES_ROOT\}\/\.incoming-/);
    assert.match(repo, /"\$\{SSH_TARGET\}:\$\{INCOMING_ROOT\}\/"/);
    assert.doesNotMatch(repo, /"\$\{SSH_TARGET\}:\$\{REMOTE_PATH\}\/"/);
    assert.match(repo, /--delete/);
  });

  it('binds the staged candidate digest before the installed guard may transition it', () => {
    const digest = script.indexOf('"$GUARD_BIN" digest --candidate-root "$INCOMING_ROOT"');
    const rename = script.indexOf('mv --no-target-directory "$INCOMING_ROOT" "$CANDIDATE_ROOT"');
    const transition = script.indexOf('"$GUARD_BIN" manager');

    assert.notEqual(digest, -1);
    assert.ok(rename > digest);
    assert.ok(transition > rename);
    assert.match(script.slice(transition), /--candidate-root "\$CANDIDATE_ROOT"/);
    assert.match(script.slice(transition), /--state-root "\$GUARD_STATE_ROOT"/);
  });

  it('publishes only one of two candidates that observed the digest path absent', async (t) => {
    const functions = script.match(
      /reconcile_existing_candidate\(\) \{[\s\S]*?\n\}\n\npublish_candidate\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    assert.ok(functions, 'the production candidate publisher is present');
    const root = mkdtempSync(join(tmpdir(), 'manager-candidate-publish-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const releases = join(root, 'releases');
    const first = join(releases, '.incoming-a');
    const second = join(releases, '.incoming-b');
    const barrier = join(root, 'barrier');
    const bin = join(root, 'bin');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    mkdirSync(barrier);
    mkdirSync(bin);
    writeFileSync(join(first, 'artifact'), 'same candidate\n');
    writeFileSync(join(second, 'artifact'), 'same candidate\n');
    const digest = 'd'.repeat(64);
    const guard = join(bin, 'guard');
    writeFileSync(guard, `#!/bin/bash\nprintf '%s\\n' '${digest}'\n`);
    chmodSync(guard, 0o700);
    const rename = join(bin, 'rename.mjs');
    writeFileSync(rename, `import { renameSync } from 'node:fs';\nconst [flag, source, target] = process.argv.slice(2);\nif (flag !== '--no-target-directory') process.exit(2);\nrenameSync(source, target);\n`);
    const mv = join(bin, 'mv');
    writeFileSync(mv, `#!/bin/bash
set -euo pipefail
touch "\${PUBLISH_BARRIER}/$$"
while [ "$(find "\${PUBLISH_BARRIER}" -type f | wc -l | tr -d ' ')" -lt 2 ]; do sleep 0.01; done
exec '${process.execPath}' '${rename}' "$@"
`);
    chmodSync(mv, 0o700);
    const harness = join(root, 'publish.sh');
    writeFileSync(harness, `#!/bin/bash
set -euo pipefail
INCOMING_ROOT="$1"
RELEASES_ROOT="$2"
CANDIDATE_DIGEST='${digest}'
CANDIDATE_ROOT="\${RELEASES_ROOT}/\${CANDIDATE_DIGEST}"
GUARD_BIN="$3"
${functions}
publish_candidate
`);
    chmodSync(harness, 0o700);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, PUBLISH_BARRIER: barrier };

    await Promise.all([
      execFileAsync(harness, [first, releases, guard], { env }),
      execFileAsync(harness, [second, releases, guard], { env }),
    ]);

    assert.deepEqual(readdirSync(releases), [digest]);
    assert.equal(readFileSync(join(releases, digest, 'artifact'), 'utf8'), 'same candidate\n');
  });

  it('routes the receipt credential only through the installed guard process environment', () => {
    assert.match(script, /: "\$\{RELEASE_GUARD_ADMIN_TOKEN:\?/);
    assert.doesNotMatch(script, /--token|Bearer|RELEASE_GUARD_ADMIN_TOKEN=/);
  });

  it('leaves the bundled tree the engines mount out of the rsync that deletes into the repo', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${INCOMING_ROOT}/"'));
    assert.ok(repo, 'the rsync into the staged candidate');
    assert.match(repo, /--delete/);
    assert.match(repo, /--exclude 'manager\/swarm-hls-stream\/'/);
  });

  /**
   * Measured on 2026-09-11: one deploy carried 1504 files of session scratch to
   * the public host, nearly half of everything it sent. The directory is
   * ignored by git, so it is by definition not part of what a host runs.
   */
  it('leaves the working notes of whoever deployed on the machine they wrote them on', () => {
    const repo = rsyncs().find((block) => block.includes('"${SSH_TARGET}:${INCOMING_ROOT}/"'));
    assert.ok(repo, 'the rsync into the staged candidate');
    assert.match(repo, /--exclude '\.scratch\/'/);
  });

  /**
   * The rsync is one of the two ways those notes could travel. The other is the
   * image build, whose context is the repository root for both images, and
   * where `.dockerignore` excluded only `*.log`, so the markdown, the JSON and
   * the screenshots under `.scratch` would still be handed to the daemon. Levi
   * ruled on 2026-09-11 that the directory stays as the local issue scratch
   * `AGENTS.md` defines and never travels anywhere.
   */
  it('keeps the working notes out of the image build context as well', () => {
    const ignore = readFileSync(join(here, '..', '..', '..', '.dockerignore'), 'utf8');
    const excluded = ignore.split('\n').map((line) => line.trim());
    assert.ok(
      excluded.includes('.scratch') || excluded.includes('.scratch/'),
      'the build context carries the scratch to the daemon',
    );
  });

  it('has nothing left of the staging tree the api used to publish at boot', () => {
    assert.equal(script.includes('bundled.incoming'), false);
  });

  it('pins the stack commit from the repository itself, not from a checkout of the submodule', () => {
    assert.match(script, /STACK_COMMIT="\$\(git rev-parse HEAD:manager\/swarm-hls-stream\)"/);
    assert.match(script, new RegExp(`printf '[^']+' "\\$STACK_COMMIT" > "\\$\{INCOMING_ROOT\}/manager/${STACK_COMMIT_FILE.replace('.', '\\.')}"`));
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

  it('lets the installed guard build before its adapter invokes the upgrade coordinator', () => {
    const build = adapter.indexOf('build api web');
    const upgrade = adapter.indexOf('node dist/cli.js manager:upgrade');
    assert.notEqual(build, -1, 'the image is built on the host');
    assert.notEqual(upgrade, -1, 'the upgrade runs in a container of the image just built');
    assert.ok(build < upgrade, 'the image exists before the upgrade runs from it');
  });

  it('decides on the host whether this manager has ever run here, before the one-off container exists', () => {
    const run = adapter.indexOf('node dist/cli.js manager:upgrade');
    assert.notEqual(run, -1, 'the upgrade runs in a one-off container');
    const before = adapter.slice(0, run);
    assert.ok(before.includes('docker volume ls -q --filter'), 'the data volume is looked for by name');
    assert.ok(before.includes('label=com.docker.compose.service=api'), 'so are the api containers of the project');
    assert.ok(before.includes('label=com.docker.compose.service=postgres'), 'and the postgres ones');
    assert.match(before, /label=com\.docker\.compose\.oneoff=False/, 'neither count a one-off container');
  });

  it('reads each probe into a variable of its own, where a docker that could not be asked stops the deploy', () => {
    // A substitution inside a [ ... ] condition reports what it printed rather than that it
    // failed, so a daemon that is down would read as a host with nothing on it and take the
    // first use branch.
    const before = adapter.slice(0, adapter.indexOf('node dist/cli.js manager:upgrade'));
    for (const [variable, probe] of [
      ['data_volume', 'docker volume ls -q --filter'],
      ['api_containers', 'label=com.docker.compose.service=api'],
      ['postgres_containers', 'label=com.docker.compose.service=postgres'],
    ]) {
      const assignmentStart = before.indexOf(`${variable}="$(`);
      const probeIndex = before.indexOf(probe);
      const assignmentEnd = before.indexOf(')"', assignmentStart);
      assert.notEqual(assignmentStart, -1, `${variable} has an assignment`);
      assert.ok(assignmentStart < probeIndex && probeIndex < assignmentEnd, `${probe} is read into ${variable}`);
      assert.equal(before.indexOf(probe, probeIndex + 1), -1, `${probe} is asked in one place`);
    }
  });

  it('stops before the upgrade when the data volume went missing under an installed manager', () => {
    const abort = adapter.indexOf('found an api container without its database volume');
    assert.notEqual(abort, -1, 'the deploy says what it found');
    assert.ok(abort < adapter.indexOf('node dist/cli.js manager:upgrade'), 'and says it before anything is published');
    assert.match(adapter.slice(abort, abort + 300), /exit 1/, 'the deploy stops there');
  });

  it('hands the first use answer to the upgrade rather than letting it probe from inside', () => {
    assert.match(adapter, /is_first_use=true/, 'the flag is set where the probes said so');
    const upgrade = adapter.slice(adapter.indexOf('node dist/cli.js manager:upgrade'));
    assert.ok(upgrade.includes('upgrade_args+=(--first-use)'), 'and reaches the command');
  });

  it('gives the upgrade the identity of the manager, of the image and how long to wait for the bundled build', () => {
    const upgrade = adapter.slice(adapter.indexOf('manager:upgrade'));
    for (const flag of ['--manager-commit', '--manager-digest', '--image-id', '--project "$project_name"',
      '--compose-file', '--compose-override', '--postgres-volume-name "$postgres_volume_name"', '--mutable-root']) {
      assert.ok(upgrade.includes(flag), `the upgrade is given ${flag}`);
    }
    assert.match(adapter, /api_image="\$\(plan_value image:api\)"/);
  });

  it('gives the upgrade no shipment, because the host builds the stack itself', () => {
    const upgrade = adapter.slice(adapter.indexOf('manager:upgrade'));
    for (const flag of ['--shipment-id', '--commit ', '--digest ', '--toolchain']) {
      assert.equal(upgrade.includes(flag), false, `the upgrade is not given ${flag}`);
    }
  });

  it('leaves the bundled build timeout at the coordinator default', () => {
    assert.doesNotMatch(adapter, /--bundled-timeout/);
  });

  /**
   * A bind mount whose source does not exist is created by Docker as a
   * root-owned directory, which the deploying user then cannot write a key or
   * a config into, and which on 2026-09-16 turned a missing ssh_config into a
   * directory the upgrade container could not start over. So the script makes
   * the directory itself, empty, as the user it runs as, before compose sees it.
   */
  it('creates the ssh identity directory as the deploying user before any container is made', () => {
    const made = adapter.indexOf('mkdir -p "$BEE_DATA_ROOT" "$STACK_VERSIONS_ROOT" "$MANAGER_SSH_DIR"');
    assert.notEqual(made, -1, 'the ssh identity directory is created with mode 700');
    assert.ok(made < adapter.indexOf('compose -f "$override" run'), 'before the upgrade container is made');
    assert.match(adapter, /export PUBLIC_HOST BEE_DATA_ROOT STACK_VERSIONS_ROOT MANAGER_SSH_DIR/);
    assert.match(adapter, /chmod 700 "\$MANAGER_SSH_DIR"/);
  });

  it('refuses an ssh target that would read as an option to ssh', () => {
    const taken = script.indexOf('SSH_TARGET="${1:-');
    const checked = script.indexOf('if [[ "$SSH_TARGET" == -* ]]');
    assert.notEqual(checked, -1, 'a leading dash makes the target an ssh flag');
    assert.ok(checked > taken, 'after the argument is taken');
    assert.ok(checked < script.indexOf('ssh "$SSH_TARGET"'), 'and before ssh is given it');
  });

  it('does not interpolate optional operator values into the remote shell', () => {
    assert.doesNotMatch(script, /BUNDLED_TIMEOUT|PUBLIC_EDGE_FLAG|FIRST_USE_FLAG/);
  });

  it('closes the upgrade coordinator standard input inside the fixed adapter', () => {
    assert.match(adapter, /compose -f "\$override" run [^\n]* "\$\{upgrade_args\[@\]\}" < \/dev\/null/);
  });

  it('asks for the public edge only where the domain says so', () => {
    assert.equal(adapter.split('--public-edge').length - 1, 1, 'the flag is decided in one place');
    const decision = adapter.indexOf('upgrade_args+=(--public-edge)');
    assert.notEqual(decision, -1, 'the public branch sets it');
    assert.ok(decision > adapter.indexOf('if [ -n "$manager_domain" ]'), 'inside the branch that saw a host name');
  });

  it('leaves the installed guard output attached to the deploy output', () => {
    assert.doesNotMatch(script, /RECEIPT=/);
    assert.match(script, /^"\$GUARD_BIN" manager \\/m);
  });

  it('lets a guard refusal fail the remote shell and the deploy', () => {
    const remote = script.slice(script.lastIndexOf("<<'REMOTE'"));
    assert.match(remote, /set -euo pipefail/);
    assert.doesNotMatch(remote, /\|\| true|UPGRADE_STATUS/);
  });

  it('lets an address probe that answered nothing through, so the warning below it is reached', () => {
    // The remote block runs under set -e with pipefail, so a failing pipe inside this
    // substitution would end it here and the warning, the upgrade and the receipt would never run.
    const line = adapter.split('\n').find((one) => one.includes('PUBLIC_HOST="$(ip -4 route get'));
    assert.ok(line, 'the remote block reads the address of the host');
    assert.match(line, /\|\| true\)"$/);
    assert.ok(adapter.indexOf('PUBLIC_HOST=') > -1);
  });

  it('uses only the installation-bound mode, project, volume, and loopback ports', () => {
    assert.match(adapter, /deployment_mode="\$\(plan_value target:mode\)"/);
    assert.match(adapter, /project_name="\$\(plan_value target:projectName\)"/);
    assert.match(adapter, /postgres_volume_name="\$\(plan_value target:postgresVolumeName\)"/);
    assert.match(adapter, /POSTGRES_PORT="\$\(plan_value target:postgresPort\)"/);
    assert.match(adapter, /WEB_PORT="\$\(plan_value target:webPort\)"/);
    assert.match(adapter, /--project-name "\$project_name"/);
    assert.match(adapter, /postgres_volume="\$postgres_volume_name"/);
  });

  it('derives an isolated layout without live roots or public edge', () => {
    assert.match(composeFile, /127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432/);
    assert.match(composeFile, /\$\{MANAGER_ROOT:-\/home\/solarpunk\/streaming-infra-manager\}:\$\{MANAGER_ROOT:-\/home\/solarpunk\/streaming-infra-manager\}/);
    assert.match(adapter, /guard_state_root="\$\{HOME\}\/\.local\/state\/streaming-release-guard"/);
    assert.match(adapter, /isolation_root="\$\{guard_state_root\}\/isolation\/\$\{project_name\}"/);
    assert.match(adapter, /isolated manager release cannot enable the public edge/);
    assert.match(adapter, /manager isolated release port is already occupied/);
    assert.doesNotMatch(adapter, /guard_(?:code|state)_root="\/home\/solarpunk/);
    for (const value of ['MANAGER_ROOT', 'POSTGRES_PORT', 'WEB_PORT', 'BEE_DATA_ROOT', 'STACK_VERSIONS_ROOT', 'MANAGER_SSH_DIR']) {
      assert.match(adapter, new RegExp(`      ${value}:`), `${value} reaches the inner coordinator`);
    }
  });

  it('verifies the running manager source, data, versions, ssh, and database mounts', () => {
    for (const destination of [
      '"$candidate_root"',
      '"$BEE_DATA_ROOT"',
      '"$STACK_VERSIONS_ROOT"',
      '/root/.ssh',
      '/var/lib/postgresql/data',
    ]) {
      assert.ok(adapter.includes(destination), `the adapter checks ${destination}`);
    }
    assert.match(adapter, /did not verify the bound manager mounts/);
    assert.match(adapter, /did not verify the bound database volume/);
  });

  it('never asks compose to print a rendered configuration', () => {
    for (const match of script.matchAll(/docker compose[^\n]*\bconfig\b[^\n]*/g)) {
      assert.match(match[0], /--quiet/, 'a rendered compose file would carry the values of every secret');
    }
  });

  it('names the versions root on the host, which is where the bundled build lands', () => {
    assert.ok(adapter.includes('streaming-infra-manager-versions'), 'the fixed adapter exports it');
  });
});
