import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import { DOCKER_BEE_STREAM_BOUNDS, type BeeBridgeQualificationRecord } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { syntheticImageId } from './syntheticDockerBee.js';

export const qualifiedBridge = (): BeeBridgeQualificationRecord => ({ id: 'synthetic-only', imageId: syntheticImageId, engineVersion: '29.1.3',
  platform: { os: 'linux', architecture: 'amd64', variant: '' }, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION,
  bridgeLifetimeSeconds: { min: 1, max: 270 }, cleanupGraceMs: { min: 1, max: 10000 }, streamBounds: DOCKER_BEE_STREAM_BOUNDS,
  harnessRevision: 'a'.repeat(40), evidenceDigest: `sha256:${'b'.repeat(64)}` });
