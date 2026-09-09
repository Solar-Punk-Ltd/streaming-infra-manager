import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureExecutionMounts, type ExecutionDockerReader } from '../../src/domain/versions/executionMountCapture.js';
import { CONTAINER_A, CONTAINER_B, DAEMON_ID, inspected } from '../support/executionMountFixtures.js';

function reader(rows: ReturnType<typeof inspected>[] = [inspected()]) {
  const calls: string[] = [];
  const source: ExecutionDockerReader = {
    readDaemonId: async () => { calls.push('daemon'); return DAEMON_ID; },
    listAllContainers: async () => { calls.push('list-all'); return rows.map(row => ({ Id: row.Id })); },
    inspectContainer: async (id) => { calls.push(id); return rows.find(row => row.Id === id); },
  };
  return { source, calls };
}

describe('read-only complete execution mount capture', () => {
  it('inspects every daemon container, including another project and stopped containers', async () => {
    const h = reader([inspected(), inspected(CONTAINER_B, { State: { Status: 'exited' }, Config: { Labels: {
      'com.docker.compose.project': 'another', 'com.docker.compose.service': 'worker',
    } } })]);
    const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID });
    assert.equal(result.state, 'complete');
    if (result.state !== 'complete') return;
    assert.deepEqual(result.containers.map(row => [row.id, row.status, row.project]), [
      [CONTAINER_A, 'running', 'owned'], [CONTAINER_B, 'exited', 'another'],
    ]);
    assert.deepEqual(h.calls, ['daemon', 'list-all', CONTAINER_A, CONTAINER_B, 'list-all', 'daemon']);
    assert.equal(result.cleanupAuthorized, false);
  });

  it('reports a complete empty observation without granting cleanup permission', async () => {
    const result = await captureExecutionMounts(reader([]).source, { daemonId: DAEMON_ID });
    assert.equal(result.state, 'complete');
    if (result.state === 'complete') assert.deepEqual(result.containers, []);
    assert.equal(result.cleanupAuthorized, false);
  });

  for (const at of ['first', 'last'] as const) {
    it(`refuses a ${at} daemon identity mismatch`, async () => {
      const h = reader(); let calls = 0;
      h.source.readDaemonId = async () => (++calls === (at === 'first' ? 1 : 2)) ? 'other-daemon' : DAEMON_ID;
      const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID });
      assert.deepEqual(result, { state: 'unknown', reason: 'daemon-mismatch', cleanupAuthorized: false });
    });
  }

  it('refuses changed or duplicate container membership instead of accepting a partial inventory', async () => {
    for (const duplicate of [false, true]) {
      const h = reader(); let calls = 0;
      h.source.listAllContainers = async () => duplicate ? [{ Id: CONTAINER_A }, { Id: CONTAINER_A }]
        : ++calls === 1 ? [{ Id: CONTAINER_A }] : [{ Id: CONTAINER_A }, { Id: CONTAINER_B }];
      const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID });
      assert.equal(result.state, 'unknown');
      if (result.state === 'unknown') assert.equal(result.reason, duplicate ? 'invalid-container-list' : 'container-set-changed');
    }
  });

  for (const raw of [
    inspected(CONTAINER_B), inspected(CONTAINER_A, { Mounts: null }),
    inspected(CONTAINER_A, { State: {} }), inspected(CONTAINER_A, { Config: { Labels: { 'com.docker.compose.project': 1 } } }),
    inspected(CONTAINER_A, { Mounts: [{ Type: 'bind', Source: '/root/../elsewhere', Destination: '/input' }] }),
    inspected(CONTAINER_A, { Mounts: [{ Type: 'bind', Destination: '/input' }] }),
  ]) {
    it('refuses malformed or mismatched inspect evidence without exposing raw output', async () => {
      const h = reader(); h.source.inspectContainer = async () => raw;
      const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID });
      assert.deepEqual(result, { state: 'unknown', reason: 'invalid-container-inspect', cleanupAuthorized: false });
    });
  }

  it('retains mounts without Compose labels, rather than dropping unmanaged containers', async () => {
    const h = reader([inspected(CONTAINER_A, { Config: {} })]);
    const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID });
    assert.equal(result.state, 'complete');
    if (result.state === 'complete') {
      assert.equal(result.containers[0]!.project, null);
      assert.equal(result.containers[0]!.mounts.length, 1);
    }
  });

  it('reports bounded transport errors without copying their text', async () => {
    const h = reader(); h.source.inspectContainer = async () => { throw new Error('synthetic-private-detail'); };
    assert.deepEqual(await captureExecutionMounts(h.source, { daemonId: DAEMON_ID }), {
      state: 'unknown', reason: 'reader-failed', cleanupAuthorized: false,
    });
  });

  it('bounds container and mount counts without returning a truncated complete result', async () => {
    const h = reader([inspected(), inspected(CONTAINER_B)]);
    const count = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID }, { maxContainers: 1 });
    assert.equal(count.state, 'unknown');
    if (count.state === 'unknown') assert.equal(count.reason, 'limit-exceeded');
    const mounts = await captureExecutionMounts(reader().source, { daemonId: DAEMON_ID }, { maxMountsPerContainer: 0 });
    assert.equal(mounts.state, 'unknown');
    if (mounts.state === 'unknown') assert.equal(mounts.reason, 'limit-exceeded');
  });

  it('uses one monotonic deadline across calls and aborts when that budget expires', async () => {
    const h = reader(); let clock = 0; let observedSignal: AbortSignal | undefined;
    h.source.readDaemonId = async signal => { observedSignal = signal; clock += 6; return DAEMON_ID; };
    h.source.listAllContainers = async () => { clock += 6; return [{ Id: CONTAINER_A }]; };
    const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID }, { timeoutMs: 10, now: () => clock });
    assert.deepEqual(result, { state: 'unknown', reason: 'timed-out', cleanupAuthorized: false });
    assert.equal(observedSignal?.aborted, true);
    assert.equal(h.calls.includes(CONTAINER_A), false);
  });

  it('aborts a never-answering read and returns within its overall budget', async () => {
    const h = reader(); let observedSignal: AbortSignal | undefined;
    h.source.readDaemonId = signal => { observedSignal = signal; return new Promise(() => {}); };
    const result = await captureExecutionMounts(h.source, { daemonId: DAEMON_ID }, { timeoutMs: 10 });
    assert.equal(result.state, 'unknown');
    if (result.state === 'unknown') assert.equal(result.reason, 'timed-out');
    assert.equal(observedSignal?.aborted, true);
  });

  it('clones the expected daemon identity before its first wait', async () => {
    const h = reader(); const expected = { daemonId: DAEMON_ID };
    h.source.readDaemonId = async () => { expected.daemonId = 'mutated'; return DAEMON_ID; };
    assert.equal((await captureExecutionMounts(h.source, expected)).state, 'complete');
  });
});
