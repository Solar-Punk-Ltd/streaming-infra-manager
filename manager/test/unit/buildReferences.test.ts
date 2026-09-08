/**
 * What keeps a build directory alive, and when a job's claim on it ends.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A deploy claim inserts a job reference for the build it will run, naming
 * the services it touches. The success hook writes one snapshot reference
 * per service from what the containers actually mount, and a job reference
 * resolves only when newer snapshots cover every service it named. Failure,
 * a failed snapshot and a crash leave it unresolved, so prune keeps the
 * build the containers may still mount. A later claim adds its own reference
 * and never touches an older one, so one profile can hold references to
 * several builds at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BuildReference,
  coveredJobReferences,
  protectedBuildIds,
} from '../../src/domain/versions/buildReferences.js';

const at = (seconds: number) => new Date(seconds * 1000);

function reference(over: Partial<BuildReference> & Pick<BuildReference, 'id' | 'holderKind' | 'buildId'>): BuildReference {
  return {
    versionId: 1,
    holderId: 'stage',
    services: [],
    createdAt: at(0),
    resolvedAt: null,
    ...over,
  };
}

describe('coveredJobReferences', () => {
  it('resolves a job once a newer snapshot covers every service it named', () => {
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['srs', 'stream-uploader'], createdAt: at(10) }),
      reference({ id: 2, holderKind: 'snapshot', buildId: 'B', holderId: 'stage/srs', services: ['srs'], createdAt: at(20) }),
      reference({ id: 3, holderKind: 'snapshot', buildId: 'B', holderId: 'stage/stream-uploader', services: ['stream-uploader'], createdAt: at(20) }),
    ];

    assert.deepEqual(coveredJobReferences(references), [1]);
  });

  it('leaves a job unresolved while one of its services has no newer snapshot', () => {
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['srs', 'stream-uploader'], createdAt: at(10) }),
      reference({ id: 2, holderKind: 'snapshot', buildId: 'B', holderId: 'stage/srs', services: ['srs'], createdAt: at(20) }),
    ];

    assert.deepEqual(coveredJobReferences(references), []);
  });

  it('does not count a snapshot older than the job, which describes the deployment before it', () => {
    const references = [
      reference({ id: 1, holderKind: 'snapshot', buildId: 'A', holderId: 'stage/srs', services: ['srs'], createdAt: at(5) }),
      reference({ id: 2, holderKind: 'job', buildId: 'B', services: ['srs'], createdAt: at(10) }),
    ];

    assert.deepEqual(coveredJobReferences(references), []);
  });

  it('resolves a job by observation of any build, not only the one it planned', () => {
    // The plan named B, the container was observed on B or on anything else:
    // what matters is that every service the job touched has been looked at
    // since the job, so the job's own reference is no longer the only record.
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['srs'], createdAt: at(10) }),
      reference({ id: 2, holderKind: 'snapshot', buildId: 'A', holderId: 'stage/srs', services: ['srs'], createdAt: at(20) }),
    ];

    assert.deepEqual(coveredJobReferences(references), [1]);
  });

  it('leaves an engine-only observation with the uploader job it does not cover', () => {
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['stream-uploader'], createdAt: at(10) }),
      reference({ id: 2, holderKind: 'job', buildId: 'C', services: ['srs'], createdAt: at(30) }),
      reference({ id: 3, holderKind: 'snapshot', buildId: 'C', holderId: 'stage/srs', services: ['srs'], createdAt: at(40) }),
    ];

    assert.deepEqual(coveredJobReferences(references), [2]);
  });

  it('ignores references already resolved', () => {
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['srs'], createdAt: at(10), resolvedAt: at(15) }),
      reference({ id: 2, holderKind: 'snapshot', buildId: 'B', holderId: 'stage/srs', services: ['srs'], createdAt: at(20) }),
    ];

    assert.deepEqual(coveredJobReferences(references), []);
  });
});

describe('protectedBuildIds', () => {
  it('protects the current and previous builds, every unresolved job reference and every snapshot reference', () => {
    const references = [
      reference({ id: 1, holderKind: 'job', buildId: 'B', services: ['srs'], createdAt: at(10) }),
      reference({ id: 2, holderKind: 'job', buildId: 'X', services: ['srs'], createdAt: at(10), resolvedAt: at(12) }),
      reference({ id: 3, holderKind: 'snapshot', buildId: 'A', holderId: 'old/srs', services: ['srs'], createdAt: at(1) }),
      reference({ id: 4, holderKind: 'operation', buildId: 'O', holderId: '7', createdAt: at(1) }),
    ];

    const protectedIds = protectedBuildIds({ buildId: 'D', previousBuildId: 'C' }, references);

    assert.deepEqual([...protectedIds].sort(), ['A', 'B', 'C', 'D', 'O']);
  });

  it('protects nothing for a row with no build and no references', () => {
    assert.deepEqual([...protectedBuildIds({ buildId: null, previousBuildId: null }, [])], []);
  });
});
