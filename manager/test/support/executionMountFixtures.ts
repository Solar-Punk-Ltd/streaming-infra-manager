import type { ExecutionRootRecord } from '../../src/domain/versions/ExecutionRoot.js';

export const EXECUTIONS_PARENT = '/synthetic/executions';
export const DAEMON_ID = 'synthetic-daemon';
export const EXECUTION_A = '11111111-1111-4111-8111-111111111111';
export const EXECUTION_B = '22222222-2222-4222-8222-222222222222';
export const CONTAINER_A = 'a'.repeat(64);
export const CONTAINER_B = 'b'.repeat(64);

export function executionRecord(id = EXECUTION_A, over: Partial<ExecutionRootRecord> = {}): ExecutionRootRecord {
  return {
    executionId: id,
    source: { versionId: 1, buildId: 'a'.repeat(40), commit: 'a'.repeat(40),
      root: `/synthetic/versions/bundled.builds/${'a'.repeat(40)}`, artifactDigest: 'd'.repeat(64) },
    profile: { name: 'owned', instanceId: '33333333-3333-4333-8333-333333333333', intentRevision: 3, status: 'DEPLOYING' },
    jobReferenceId: 5, target: { alias: 'localhost', daemonId: DAEMON_ID }, project: 'owned', action: 'deploy', services: ['srs', 'ome'],
    root: `${EXECUTIONS_PARENT}/${id}/tree`, state: 'launch-uncertain', copyToken: '44444444-4444-4444-8444-444444444444',
    referenceId: 7, createdAt: new Date(0), ...over,
  };
}

export function inspected(id = CONTAINER_A, over: Record<string, unknown> = {}) {
  const root = executionRecord().root;
  return {
    Id: id, State: { Status: 'running' }, Config: { Labels: {
      'com.docker.compose.project': 'owned', 'com.docker.compose.service': 'srs',
      'com.docker.compose.project.working_dir': `${root}/deploy`,
    } }, Mounts: [{ Type: 'bind', Source: `${root}/engines/srs/entrypoint.sh`, Destination: '/entrypoint.sh' }], ...over,
  };
}
