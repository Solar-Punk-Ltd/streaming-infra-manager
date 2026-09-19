import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ExecutionDockerReader } from '../../src/domain/versions/executionMountCapture.js';
import { ExecutionRootService } from '../../src/domain/versions/ExecutionRootService.js';
import type { ExecutionRootRecord } from '../../src/domain/versions/ExecutionRoot.js';
import { InMemoryExecutionRoots } from '../support/InMemoryExecutionRoots.js';

const DAEMON = 'retention-daemon';
const PROFILE = 'stage';
const INSTANCE = '33333333-3333-4333-8333-333333333333';

let root: string;
let executions: string;
let store: InMemoryExecutionRoots;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'execution-retirement-'));
  executions = join(root, '.executions');
  await mkdir(executions, { mode: 0o700 });
  store = new InMemoryExecutionRoots(executions, () => INSTANCE);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function launched(services: string[]): Promise<ExecutionRootRecord> {
  const executionId = randomUUID();
  const record = await store.register({
    executionId,
    source: {
      versionId: 2,
      buildId: 'a'.repeat(40),
      commit: 'a'.repeat(40),
      root: join(root, 'v3.builds', 'a'.repeat(40)),
      artifactDigest: 'b'.repeat(64),
    },
    profile: { name: PROFILE, instanceId: INSTANCE, intentRevision: store.records.length + 1, status: 'DEPLOYING' },
    jobReferenceId: store.records.length + 1,
    target: { alias: 'localhost', daemonId: DAEMON },
    action: 'deploy',
    services,
  });
  await mkdir(record.root, { recursive: true, mode: 0o700 });
  await writeFile(join(dirname(record.root), 'owner.json'), JSON.stringify({ executionId }));
  const copying = (await store.beginCopy(executionId))!;
  await store.markReady(executionId, copying.copyToken!, record.source.artifactDigest);
  await store.claimLaunch(executionId);
  return store.records.find(row => row.executionId === executionId)!;
}

function inspected(record: ExecutionRootRecord, service: string, id: string) {
  return {
    Id: id.repeat(64),
    State: { Status: 'running' },
    Config: { Labels: {
      'com.docker.compose.project': PROFILE,
      'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': `${record.root}/deploy`,
    } },
    Mounts: [{ Type: 'bind', Source: `${record.root}/engines/${service}/entrypoint.sh`, Destination: '/entrypoint.sh' }],
  };
}

function reader(rows: Array<{ Id: string } & Record<string, unknown>>): ExecutionDockerReader {
  return {
    readDaemonId: async () => DAEMON,
    listAllContainers: async () => rows.map(row => ({ Id: row.Id })),
    inspectContainer: async id => rows.find(row => row.Id === id),
  };
}

describe('launched execution retirement', () => {
  it('keeps the full execution when an uploader-only success leaves its engine mounted', async () => {
    const full = await launched(['srs', 'stream-uploader']);
    const uploader = await launched(['stream-uploader']);
    const service = new ExecutionRootService(store, executions, async () => reader([
      inspected(full, 'srs', 'a'),
      inspected(uploader, 'stream-uploader', 'b'),
    ]));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(full.executionId), 'launch-uncertain');
    assert.equal(existsSync(full.root), true);
  });

  it('keeps every launched execution when complete mount observation is unavailable', async () => {
    const full = await launched(['srs', 'stream-uploader']);
    await launched(['stream-uploader']);
    const service = new ExecutionRootService(store, executions, async () => null);

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(full.executionId), 'launch-uncertain');
    assert.equal(existsSync(full.root), true);
  });

  it('keeps the last working execution when a later launch fails', async () => {
    const working = await launched(['srs', 'stream-uploader']);
    await launched(['stream-uploader']);
    await launched(['stream-uploader']);
    const service = new ExecutionRootService(store, executions, async () => reader([
      inspected(working, 'srs', 'e'),
    ]));

    await service.retireSuperseded(PROFILE, { keep: 2 });

    assert.equal(store.stateOf(working.executionId), 'launch-uncertain');
    assert.equal(existsSync(working.root), true);
  });

  it('keeps every candidate when a container names an unregistered execution path', async () => {
    const previous = await launched(['srs', 'stream-uploader']);
    const current = await launched(['srs', 'stream-uploader']);
    const unknown = `${executions}/${randomUUID()}/tree`;
    const row = inspected(current, 'srs', 'f');
    row.Mounts = [{ Type: 'bind', Source: `${unknown}/engines/srs/entrypoint.sh`, Destination: '/entrypoint.sh' }];
    const service = new ExecutionRootService(store, executions, async () => reader([row]));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(previous.executionId), 'launch-uncertain');
    assert.equal(existsSync(previous.root), true);
  });

  it('keeps every candidate when inspect omits its mount inventory', async () => {
    const previous = await launched(['srs', 'stream-uploader']);
    await launched(['srs', 'stream-uploader']);
    const service = new ExecutionRootService(store, executions, async () => ({
      readDaemonId: async () => DAEMON,
      listAllContainers: async () => [{ Id: 'f'.repeat(64) }],
      inspectContainer: async () => ({
        Id: 'f'.repeat(64),
        State: { Status: 'running' },
        Config: { Labels: {} },
      }),
    }));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(previous.executionId), 'launch-uncertain');
    assert.equal(existsSync(previous.root), true);
  });

  it('retires the previous execution after every observed mount has moved', async () => {
    const previous = await launched(['srs', 'stream-uploader']);
    const current = await launched(['srs', 'stream-uploader']);
    const service = new ExecutionRootService(store, executions, async () => reader([
      inspected(current, 'srs', 'c'),
      inspected(current, 'stream-uploader', 'd'),
    ]));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(previous.executionId), 'released');
    assert.equal(existsSync(dirname(previous.root)), false);
  });

  it('does not mistake the manager API administrative mounts for deployment consumers', async () => {
    const previous = await launched(['srs', 'stream-uploader']);
    const current = await launched(['srs', 'stream-uploader']);
    const managerApi = {
      Id: '9'.repeat(64),
      State: { Status: 'running' },
      Config: { Labels: {
        'com.docker.compose.project': 'manager',
        'com.docker.compose.service': 'api',
        'com.docker.compose.project.working_dir': '/home/solarpunk/streaming-infra-manager/manager',
      } },
      Mounts: [
        { Type: 'bind', Source: dirname(executions), Destination: dirname(executions) },
        { Type: 'bind', Source: '/', Destination: '/host/rootfs' },
      ],
    };
    const service = new ExecutionRootService(store, executions, async () => reader([
      managerApi,
      inspected(current, 'srs', '7'),
      inspected(current, 'stream-uploader', '8'),
    ]));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(previous.executionId), 'released');
    assert.equal(existsSync(dirname(previous.root)), false);
  });

  it('retains an execution reachable through a foreign parent bind', async () => {
    const previous = await launched(['srs', 'stream-uploader']);
    const current = await launched(['srs', 'stream-uploader']);
    const foreign = {
      Id: '6'.repeat(64),
      State: { Status: 'running' },
      Config: { Labels: {} },
      Mounts: [{ Type: 'bind', Source: executions, Destination: '/data' }],
    };
    const service = new ExecutionRootService(store, executions, async () => reader([
      foreign,
      inspected(current, 'srs', '4'),
      inspected(current, 'stream-uploader', '5'),
    ]));

    await service.retireSuperseded(PROFILE, { keep: 1 });

    assert.equal(store.stateOf(previous.executionId), 'launch-uncertain');
    assert.equal(existsSync(previous.root), true);
  });
});
