import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { observeExecutionMounts } from '../../src/domain/versions/executionMountAttribution.js';
import type { ExecutionDockerReader } from '../../src/domain/versions/executionMountCapture.js';
import { CONTAINER_A, CONTAINER_B, DAEMON_ID, EXECUTION_A, EXECUTION_B, EXECUTIONS_PARENT, executionRecord, inspected } from '../support/executionMountFixtures.js';

function reader(rows: ReturnType<typeof inspected>[]): ExecutionDockerReader {
  return { readDaemonId: async () => DAEMON_ID, listAllContainers: async () => rows.map(row => ({ Id: row.Id })),
    inspectContainer: async id => rows.find(row => row.Id === id) };
}
function registry(records = [executionRecord()]) { return { daemonId: DAEMON_ID, executionsParent: EXECUTIONS_PARENT, records }; }
function labels(root: string, service = 'srs', project = 'owned') { return { Labels: {
  'com.docker.compose.project': project, 'com.docker.compose.service': service,
  'com.docker.compose.project.working_dir': `${root}/deploy`,
} }; }
function mount(root: string) { return [{ Type: 'bind', Source: `${root}/engines/input`, Destination: '/input' }]; }

describe('read-only registered execution attribution', () => {
  it('attributes a recorded source and job without looking up the current version or granting cleanup', async () => {
    const record = executionRecord();
    const result = await observeExecutionMounts(reader([inspected()]), registry([record]));
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.deepEqual(result.containers[0]!.attribution, { state: 'registered-execution', executionId: EXECUTION_A,
      source: record.source, profile: record.profile, jobReferenceId: record.jobReferenceId });
    assert.deepEqual(result.containers[0]!.dependencies, [{ executionId: EXECUTION_A, source: record.source }]);
    assert.equal(result.containers[0]!.dependencyState, 'single');
    assert.equal(result.cleanupAuthorized, false);
  });

  it('keeps both stopped and running instances of the same service and their distinct registered sources', async () => {
    const a = executionRecord(); const b = executionRecord(EXECUTION_B, { jobReferenceId: 6, referenceId: 8,
      source: { ...a.source, buildId: 'b'.repeat(40), commit: 'b'.repeat(40), root: a.source.root.replace(/a{40}$/, 'b'.repeat(40)) } });
    const result = await observeExecutionMounts(reader([inspected(), inspected(CONTAINER_B, {
      State: { Status: 'exited' }, Config: labels(b.root), Mounts: mount(b.root),
    })]), registry([a, b]));
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.deepEqual(result.containers.map(c => [c.status, c.attribution.state, c.dependencies[0]?.executionId]), [
      ['running', 'registered-execution', EXECUTION_A], ['exited', 'registered-execution', EXECUTION_B],
    ]);
  });

  for (const config of [undefined, labels(executionRecord().root, 'worker'), labels(executionRecord().root, 'srs', 'foreign')]) {
    it('retains dependencies when Compose provenance is missing, another service or another project', async () => {
      const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Config: config ?? {} })]), registry());
      assert.equal(result.state, 'complete');
      if (result.state !== 'complete') return;
      assert.equal(result.containers[0]!.attribution.state, 'unknown');
      assert.equal(result.containers[0]!.dependencies[0]!.executionId, EXECUTION_A);
    });
  }

  it('does not collapse mixed working-directory and mount roots into one effective build', async () => {
    const b = executionRecord(EXECUTION_B, { jobReferenceId: 6, referenceId: 8 });
    const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Mounts: mount(b.root) })]), registry([executionRecord(), b]));
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.deepEqual(result.containers[0]!.attribution, { state: 'ambiguous', reason: 'mixed-execution-roots' });
    assert.equal(result.containers[0]!.dependencies[0]!.executionId, EXECUTION_B);
    assert.equal(result.containers[0]!.workingDirectoryExecutionId, EXECUTION_A);
  });

  it('lists all registered dependencies when one container mounts more than one execution', async () => {
    const b = executionRecord(EXECUTION_B, { jobReferenceId: 6, referenceId: 8 });
    const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Mounts: [...mount(executionRecord().root), ...mount(b.root)] })]), registry([executionRecord(), b]));
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.equal(result.containers[0]!.dependencyState, 'multiple');
    assert.deepEqual(result.containers[0]!.dependencies.map(d => d.executionId), [EXECUTION_A, EXECUTION_B]);
  });

  for (const source of [EXECUTIONS_PARENT, '/synthetic']) {
    it(`retains every execution accessible through an ancestor bind of ${source}`, async () => {
      const b = executionRecord(EXECUTION_B, { jobReferenceId: 6, referenceId: 8 });
      const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Config: {},
        Mounts: [{ Type: 'bind', Source: source, Destination: '/input' }],
      })]), registry([executionRecord(), b]));
      assert.equal(result.state, 'complete');
      if (result.state !== 'complete') return;
      assert.deepEqual(result.containers[0]!.dependencies.map(d => d.executionId), [EXECUTION_A, EXECUTION_B]);
      assert.equal(result.containers[0]!.dependencyState, 'multiple');
      assert.equal(result.containers[0]!.attribution.state, 'unknown');
      assert.deepEqual(result.containers[0]!.unmatchedBindSources, []);
      assert.equal(result.cleanupAuthorized, false);
    });
  }

  for (const source of ['/disjoint/data', executionRecord().source.root]) {
    it(`does not label a direct non-execution bind of ${source} as an execution-copy dependency`, async () => {
      const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Config: {},
        Mounts: [{ Type: 'bind', Source: source, Destination: '/input' }],
      })]), registry());
      assert.equal(result.state, 'complete');
      if (result.state !== 'complete') return;
      assert.deepEqual(result.containers[0]!.dependencies, []);
      assert.equal(result.containers[0]!.dependencyState, 'none');
      assert.deepEqual(result.containers[0]!.unmatchedBindSources, [source]);
      assert.equal(result.containers[0]!.attribution.state, 'unknown');
      assert.equal(result.cleanupAuthorized, false);
    });
  }

  for (const path of [`${executionRecord().root}-other`, `${EXECUTIONS_PARENT}/99999999-9999-4999-8999-999999999999/tree`]) {
    it('does not derive identity from an unregistered path or prefix lookalike', async () => {
      const result = await observeExecutionMounts(reader([inspected(CONTAINER_A, { Config: labels(path), Mounts: mount(path) })]), registry());
      assert.equal(result.state, 'complete');
      if (result.state !== 'complete') return;
      assert.deepEqual(result.containers[0]!.dependencies, []);
      assert.equal(result.containers[0]!.dependencyState, 'unknown');
      assert.equal(result.containers[0]!.attribution.state, 'unknown');
      assert.equal(result.cleanupAuthorized, false);
    });
  }

  it('reports unmatched ordinary mounts and an empty inventory without granting permission', async () => {
    for (const rows of [[], [inspected(CONTAINER_A, { Config: {}, Mounts: mount('/ordinary/data') })]]) {
      const result = await observeExecutionMounts(reader(rows), registry());
      assert.equal(result.state, 'complete');
      if (result.state !== 'complete') return;
      if (rows.length) {
        assert.equal(result.containers[0]!.dependencyState, 'none');
        assert.deepEqual(result.containers[0]!.unmatchedBindSources, ['/ordinary/data/engines/input']);
      }
      assert.equal(result.cleanupAuthorized, false);
    }
  });

  for (const records of [
    [executionRecord({} as string)],
    [executionRecord(EXECUTION_A, { root: `${EXECUTIONS_PARENT}/elsewhere/tree` })],
    [executionRecord(EXECUTION_A, { root: `${EXECUTIONS_PARENT}/../elsewhere` })],
    [executionRecord(EXECUTION_A, { project: 'other' })],
    [executionRecord(EXECUTION_A, { source: { ...executionRecord().source, artifactDigest: 'invalid' } })],
    [executionRecord(), executionRecord()],
    [executionRecord(EXECUTION_A, { state: 'released' })],
  ]) {
    it('refuses invalid or duplicate registry evidence before reading the daemon', async () => {
      let reads = 0; const source = reader([]); source.readDaemonId = async () => { reads++; return DAEMON_ID; };
      assert.deepEqual(await observeExecutionMounts(source, registry(records)), {
        state: 'unknown', reason: 'invalid-registry', cleanupAuthorized: false,
      });
      assert.equal(reads, 0);
    });
  }

  it('does not attribute a matching lexical path registered on another daemon', async () => {
    const record = executionRecord(EXECUTION_A, { target: { alias: 'other', daemonId: 'other-daemon' } });
    const result = await observeExecutionMounts(reader([inspected()]), registry([record]));
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.deepEqual(result.containers[0]!.dependencies, []);
    assert.equal(result.containers[0]!.attribution.state, 'unknown');
  });

  it('freezes registry identity before a delayed capture can observe caller mutation', async () => {
    const input = registry(); const source = reader([inspected()]);
    source.readDaemonId = async () => { input.records[0]!.source.buildId = 'b'.repeat(40); input.records[0]!.jobReferenceId = 999; return DAEMON_ID; };
    const result = await observeExecutionMounts(source, input);
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    const attribution = result.containers[0]!.attribution;
    assert.equal(attribution.state, 'registered-execution');
    if (attribution.state === 'registered-execution') {
      assert.equal(attribution.source.buildId, 'a'.repeat(40));
      assert.equal(attribution.jobReferenceId, 5);
    }
  });
});
