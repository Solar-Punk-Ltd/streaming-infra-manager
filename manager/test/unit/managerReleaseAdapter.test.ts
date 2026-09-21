import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const fixtureNetwork = {
  name: 'srs-continuation-20260920-a1b2c3d4-network',
  fixtureId: 'srs-continuation-20260920-a1b2c3d4',
};
const fixtureNetworkId = 'd'.repeat(64);
const managerNetworkId = 'f'.repeat(64);
const imageId = `sha256:${'a'.repeat(64)}`;
const webImageId = `sha256:${'b'.repeat(64)}`;
const target = {
  mode: 'isolated',
  projectName: 'manager-fixture',
  postgresVolumeName: 'manager-fixture-pg',
  postgresPort: 25_432,
  webPort: 28_080,
} as const;
const managerNetworkName = `${target.projectName}-fixture-manager`;

async function temporaryRoot(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'manager-release-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function candidateAt(root: string): Promise<{
  adapter: string;
  candidate: string;
  guardInstallation: { codeRoot: string; stateRoot: string };
  home: string;
}> {
  const candidate = join(root, 'candidate');
  const adapter = join(candidate, 'deploy/release-adapters/manager.sh');
  await mkdir(dirname(adapter), { recursive: true });
  await mkdir(join(candidate, 'manager'), { recursive: true });
  await copyFile(join(repositoryRoot, 'deploy/release-adapters/manager.sh'), adapter);
  await chmod(adapter, 0o700);
  await writeFile(join(candidate, 'manager/docker-compose.yml'), 'services: {}\n');
  await writeFile(join(candidate, 'manager/.env'), 'MANAGER_DOMAIN=\n');
  await writeFile(join(candidate, '.release-commit'), `${'c'.repeat(40)}\n`);
  const home = join(root, 'home');
  await mkdir(home);
  const guardInstallation = {
    codeRoot: join(root, 'installed-guard/lib/streaming-release-guard/current'),
    stateRoot: join(root, 'installed-guard/state/streaming-release-guard'),
  };
  await mkdir(guardInstallation.codeRoot, { recursive: true });
  await mkdir(guardInstallation.stateRoot, { recursive: true });
  await writeFile(join(guardInstallation.codeRoot, 'container-binding.json'), JSON.stringify({
    schemaVersion: 1,
    stateRoot: guardInstallation.stateRoot,
  }));
  return { adapter, candidate: await realpath(candidate), guardInstallation, home };
}

function plan(
  phase: 'preflight' | 'transition' | 'verify',
  candidate: string,
  guardInstallation: { codeRoot: string; stateRoot: string },
) {
  const treeDigest = 'e'.repeat(64);
  return {
    schemaVersion: 1,
    phase,
    temporaryProject: `release-${treeDigest.slice(0, 20)}`,
    candidateRoot: candidate,
    treeDigest,
    slot: { role: 'manager', id: 'default' },
    images: phase === 'preflight'
      ? []
      : [
          { service: 'api', imageId },
          { service: 'web', imageId: webImageId },
        ],
    activeArtifactPath: null,
    arguments: {
      guardInstallation,
      target,
      fixtureNetwork: {
        ...fixtureNetwork,
        ...(phase === 'preflight' ? {} : { networkId: fixtureNetworkId }),
      },
    },
  };
}

async function writeFakeDocker(root: string, candidate: string, guardStateRoot: string): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin);
  const docker = join(bin, 'docker');
  const sharedAttached = join(root, 'shared-attached');
  const isolationRoot = join(guardStateRoot, 'isolation', target.projectName);
  const composeConfig = {
    name: target.projectName,
    services: Object.fromEntries(['postgres', 'api', 'web'].map((service) => [service, {
      cpus: 1,
      mem_limit: '1073741824',
      pids_limit: 256,
      labels: {
        'org.solarpunk.srs-continuation.fixture': fixtureNetwork.fixtureId,
        'org.solarpunk.srs-continuation.managed': 'true',
      },
      networks: { fixture_manager: null },
    }])),
    networks: {
      fixture_manager: { external: true, name: managerNetworkName },
    },
  };
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'docker.log'))}, JSON.stringify(args) + '\\n');
const formatAt = args.indexOf('--format');
const format = formatAt < 0 ? '' : args[formatAt + 1];
const last = args.at(-1);
const container = last;
const containers = { api: 'manager-api-container', web: 'manager-web-container', postgres: 'manager-postgres-container' };
const networkId = ${JSON.stringify(fixtureNetworkId)};
const managerNetworkId = ${JSON.stringify(managerNetworkId)};
const fixtureId = ${JSON.stringify(fixtureNetwork.fixtureId)};
const managerNetwork = ${JSON.stringify(managerNetworkName)};
const volumeName = ${JSON.stringify(target.postgresVolumeName)};
const imageId = ${JSON.stringify(imageId)};
const webImageId = ${JSON.stringify(webImageId)};
function out(value) { process.stdout.write(String(value) + '\\n'); }
if (args[0] === 'network' && args[1] === 'inspect') {
  const inspectedNetwork = last;
  if (format.includes('.Id')) out(inspectedNetwork === managerNetwork ? managerNetworkId : networkId);
  else if (format.includes('.Internal')) out('true');
  else if (format.includes('org.solarpunk.srs-continuation.fixture')) out(process.env.FAKE_BAD_LABEL === '1' ? 'wrong-fixture' : fixtureId);
  else if (format.includes('org.solarpunk.srs-continuation.managed')) out('true');
  else process.exit(31);
} else if (args[0] === 'network' && args[1] === 'connect') {
  if (!args.includes('--alias') || args[args.indexOf('--alias') + 1] !== 'manager-api') process.exit(33);
  if (args.at(-2) !== networkId || last !== containers.api) process.exit(34);
  fs.writeFileSync(${JSON.stringify(sharedAttached)}, 'attached');
} else if (args[0] === 'volume' && args[1] === 'ls') {
  out(volumeName);
} else if (args[0] === 'volume' && args[1] === 'inspect') {
  if (format.includes('.Name')) out(volumeName);
  else if (format.includes('org.solarpunk.srs-continuation.fixture')) out(fixtureId);
  else if (format.includes('org.solarpunk.srs-continuation.managed')) out('true');
} else if (args[0] === 'ps') {
  out('existing-container');
} else if (args[0] === 'compose') {
  if (args.includes('config')) out(${JSON.stringify(JSON.stringify(composeConfig))});
  else if (args.includes('ps') && args.includes('-q')) out(containers[last]);
} else if (args[0] === 'inspect') {
  if (format.includes('.State.Status')) out('running');
  else if (format.includes('.State.Health')) out(container === containers.api ? '' : 'healthy');
  else if (format === '{{.Image}}') out(container === containers.api ? imageId : webImageId);
  else if (format.includes('.Mounts')) {
    if (container === containers.postgres) out(volumeName);
    else if (format.includes('/root/.ssh')) out(${JSON.stringify(join(isolationRoot, 'ssh'))});
    else if (format.includes(${JSON.stringify(join(isolationRoot, 'data'))})) out(${JSON.stringify(join(isolationRoot, 'data'))});
    else if (format.includes(${JSON.stringify(join(isolationRoot, 'versions'))})) out(${JSON.stringify(join(isolationRoot, 'versions'))});
    else out(${JSON.stringify(candidate)});
  } else if (format.includes('.Config.Labels')) {
    if (format.includes('org.solarpunk.srs-continuation.fixture')) out(process.env.FAKE_BAD_CONTAINER_LABEL === '1' ? 'foreign-fixture' : fixtureId);
    else out('true');
  } else if (format.includes('.NetworkSettings.Networks')) {
    const managerMembership = { NetworkID: managerNetworkId, Aliases: [container === containers.api ? 'api' : container === containers.web ? 'web' : 'postgres'] };
    const memberships = { [managerNetwork]: managerMembership };
    if (container === containers.api && fs.existsSync(${JSON.stringify(sharedAttached)})) {
      memberships[${JSON.stringify(fixtureNetwork.name)}] = {
        NetworkID: networkId,
        Aliases: process.env.FAKE_BAD_ALIAS === '1' ? ['api', 'manager-api'] : ['manager-api'],
      };
    }
    if (process.env.FAKE_EXTRA_NETWORK === '1') memberships.extra = { NetworkID: '9'.repeat(64), Aliases: [] };
    if (format.includes('json')) out(JSON.stringify(memberships));
    else out(memberships[managerNetwork]?.NetworkID ?? '');
  } else if (format.includes('.HostConfig.NanoCpus')) out(process.env.FAKE_BAD_CAP === '1' ? '2000000000' : '1000000000');
  else if (format.includes('.HostConfig.Memory')) out('1073741824');
  else if (format.includes('.HostConfig.PidsLimit')) out('256');
  else if (format.includes('.NetworkSettings.Ports')) {
    if (container === containers.api) out('{}');
    else if (container === containers.postgres) out(JSON.stringify({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: process.env.FAKE_BAD_PORT === '1' ? '5432' : '${target.postgresPort}' }] }));
    else out(JSON.stringify({ '80/tcp': [{ HostIp: process.env.FAKE_BAD_PORT === '1' ? '0.0.0.0' : '127.0.0.1', HostPort: '${target.webPort}' }] }));
  } else process.exit(32);
}
`);
  await chmod(docker, 0o700);
  return bin;
}

async function runAdapter(input: {
  adapter: string;
  candidate: string;
  guardInstallation: { codeRoot: string; stateRoot: string };
  home: string;
  root: string;
  phase: 'preflight' | 'transition' | 'verify';
  env?: NodeJS.ProcessEnv;
}) {
  const planPath = join(input.root, `${input.phase}-plan.json`);
  const output = join(input.root, `${input.phase}.json`);
  await writeFile(planPath, JSON.stringify(plan(input.phase, input.candidate, input.guardInstallation)));
  const args = [input.phase, '--plan', planPath];
  if (input.phase !== 'transition') args.push('--output', output);
  await execFileAsync(input.adapter, args, {
    env: { ...process.env, HOME: input.home, ...input.env },
  });
  return output;
}

describe('manager fixture release adapter', () => {
  it('binds the derived internal manager network and writes the capped isolated topology', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = await candidateAt(root);
    const bin = await writeFakeDocker(root, candidate.candidate, candidate.guardInstallation.stateRoot);
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}` };

    const preflightOutput = await runAdapter({ ...candidate, root, phase: 'preflight', env });
    assert.deepEqual(JSON.parse(await readFile(preflightOutput, 'utf8')), {
      schemaVersion: 1,
      fixtureNetworkId,
      guardInstallation: candidate.guardInstallation,
    });

    await runAdapter({ ...candidate, root, phase: 'transition', env });
    await runAdapter({ ...candidate, root, phase: 'transition', env });
    const override = await readFile(join(root, 'manager-image-override.yml'), 'utf8');
    assert.match(override, new RegExp(`name: ${managerNetworkName}`));
    assert.doesNotMatch(override, new RegExp(`name: ${fixtureNetwork.name}`));
    assert.equal(override.match(/cpus: 1/g)?.length, 3);
    assert.equal(override.match(/mem_limit: 1073741824/g)?.length, 3);
    assert.equal(override.match(/pids_limit: 256/g)?.length, 3);
    assert.equal(override.match(new RegExp(`org\\.solarpunk\\.srs-continuation\\.fixture: ${fixtureNetwork.fixtureId}`, 'g'))?.length, 5);
    assert.equal(override.match(/org\.solarpunk\.srs-continuation\.managed: "true"/g)?.length, 5);
    assert.match(override, new RegExp(`name: ${target.postgresVolumeName}`));
    assert.match(override, new RegExp(`name: ${managerNetworkName}\\n    internal: true`));
    assert.match(override, new RegExp(`127\\.0\\.0\\.1:${target.postgresPort}:5432`));
    assert.match(override, new RegExp(`127\\.0\\.0\\.1:${target.webPort}:80`));
    assert.match(override, /RELEASE_GUARD_STATE_ROOT:/);
    assert.doesNotMatch(override, /RELEASE_GUARD_ADMIN_TOKEN/);
    const calls = (await readFile(join(root, 'docker.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter((args) => args.join(' ') === `network connect --alias manager-api ${fixtureNetworkId} manager-api-container`).length,
      1,
    );
    assert.ok(!calls.some((args) => args.includes('--alias') && args[args.indexOf('--alias') + 1] === 'api'));

    const verifyOutput = await runAdapter({ ...candidate, root, phase: 'verify', env });
    assert.deepEqual(JSON.parse(await readFile(verifyOutput, 'utf8')), {
      schemaVersion: 1,
      images: [
        { service: 'api', imageId },
        { service: 'web', imageId: webImageId },
      ],
    });
  });

  it('refuses the wrong manager fixture network identity during preflight', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = await candidateAt(root);
    const bin = await writeFakeDocker(root, candidate.candidate, candidate.guardInstallation.stateRoot);

    await assert.rejects(
      runAdapter({
        ...candidate,
        root,
        phase: 'preflight',
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_BAD_LABEL: '1' },
      }),
      /fixture network identity does not match/,
    );
  });

  it('refuses a foreign api container before attaching it to the shared network', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = await candidateAt(root);
    const bin = await writeFakeDocker(root, candidate.candidate, candidate.guardInstallation.stateRoot);
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_BAD_CONTAINER_LABEL: '1',
    };

    await assert.rejects(
      runAdapter({ ...candidate, root, phase: 'transition', env }),
      /fixture container identity does not match/,
    );
    const calls = (await readFile(join(root, 'docker.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[0] === 'network' && args[1] === 'connect'), false);
  });

  for (const [name, env, message] of [
    ['resource cap', { FAKE_BAD_CAP: '1' }, /resource limits/],
    ['published port', { FAKE_BAD_PORT: '1' }, /published ports/],
    ['shared-network alias', { FAKE_BAD_ALIAS: '1' }, /network membership/],
    ['extra network membership', { FAKE_EXTRA_NETWORK: '1' }, /network membership/],
  ] as const) {
    it(`refuses a running manager with the wrong ${name}`, async (t) => {
      const root = await temporaryRoot(t);
      const candidate = await candidateAt(root);
      const bin = await writeFakeDocker(root, candidate.candidate, candidate.guardInstallation.stateRoot);
      const baseEnv = { PATH: `${bin}:${process.env.PATH ?? ''}` };
      await runAdapter({ ...candidate, root, phase: 'transition', env: baseEnv });

      await assert.rejects(
        runAdapter({ ...candidate, root, phase: 'verify', env: { ...baseEnv, ...env } }),
        message,
      );
    });
  }
});
