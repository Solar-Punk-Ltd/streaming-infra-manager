import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBeeBridgeQualifier, type BeeBridgeExecution, type BeeBridgeQualificationRecord,
  PRODUCTION_BEE_BRIDGE_QUALIFICATIONS, DOCKER_BEE_STREAM_BOUNDS } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';

const execution = (): BeeBridgeExecution => ({ imageId: `sha256:${'d'.repeat(64)}`, engineVersion: '29.1.3',
  platform: { os: 'linux', architecture: 'amd64', variant: '' }, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION,
  bridgeLifetimeSeconds: 270, cleanupGraceMs: 5000, streamBounds: { ...DOCKER_BEE_STREAM_BOUNDS } });
const record = (): BeeBridgeQualificationRecord => ({ id: 'synthetic-qualified-build', imageId: execution().imageId,
  engineVersion: '29.1.3', platform: { ...execution().platform }, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION,
  harnessRevision: 'a'.repeat(40), evidenceDigest: `sha256:${'b'.repeat(64)}`,
  bridgeLifetimeSeconds: { min: 1, max: 270 }, cleanupGraceMs: { min: 1, max: 5000 }, streamBounds: { ...DOCKER_BEE_STREAM_BOUNDS } });

describe('trusted Bee bridge execution qualification', () => {
  it('ships the images that were checked, and still refuses one that was not', () => {
    assert.ok(Object.isFrozen(PRODUCTION_BEE_BRIDGE_QUALIFICATIONS));
    assert.ok(PRODUCTION_BEE_BRIDGE_QUALIFICATIONS.length > 0, 'the catalogue is what makes a transfer possible at all');
    // An image nobody checked is still refused, selected or not, which is the
    // whole point of the list.
    assert.equal(createBeeBridgeQualifier()(execution()), false);
    assert.equal(createBeeBridgeQualifier(PRODUCTION_BEE_BRIDGE_QUALIFICATIONS,
      PRODUCTION_BEE_BRIDGE_QUALIFICATIONS.map((entry) => entry.id))(execution()), false);
  });

  it('pins every shipped record to the bridge script as it stands, so editing the script requalifies', () => {
    for (const entry of PRODUCTION_BEE_BRIDGE_QUALIFICATIONS) {
      assert.equal(entry.bridgeRevision, DOCKER_BEE_BRIDGE_REVISION,
        `${entry.id} was qualified against another bridge script. Run manager/scripts/qualify-bee-bridge.mjs again.`);
    }
  });

  it('qualifies an execution of a shipped image, which is what lets a transfer run at all', () => {
    for (const entry of PRODUCTION_BEE_BRIDGE_QUALIFICATIONS) {
      const qualify = createBeeBridgeQualifier(PRODUCTION_BEE_BRIDGE_QUALIFICATIONS, [entry.id]);
      assert.equal(qualify({ ...execution(), imageId: entry.imageId, engineVersion: entry.engineVersion,
        platform: { ...entry.platform }, bridgeLifetimeSeconds: entry.bridgeLifetimeSeconds.max,
        cleanupGraceMs: entry.cleanupGraceMs.max }), true, entry.id);
    }
  });

  it('accepts only a selected exact record and the tested bounds', () => {
    const qualify = createBeeBridgeQualifier([record()], ['synthetic-qualified-build']);
    assert.equal(qualify(execution()), true);
    assert.equal(createBeeBridgeQualifier([record()], [])(execution()), false);
    assert.equal(createBeeBridgeQualifier([record()], ['another-build'])(execution()), false);
  });

  for (const changed of [
    { imageId: `sha256:${'e'.repeat(64)}` }, { engineVersion: '29.1.4' },
    { platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
    { platform: { os: 'windows', architecture: 'amd64', variant: '' } },
    { platform: { os: 'linux', architecture: 'amd64', variant: 'v2' } },
    { bridgeRevision: `sha256:${'f'.repeat(64)}` }, { bridgeLifetimeSeconds: 271 }, { bridgeLifetimeSeconds: 0 },
    { cleanupGraceMs: 5001 }, { cleanupGraceMs: 0 },
    { streamBounds: { ...DOCKER_BEE_STREAM_BOUNDS, maxOutputBytes: DOCKER_BEE_STREAM_BOUNDS.maxOutputBytes + 1 } },
  ]) {
    it(`does not qualify changed execution facts ${JSON.stringify(changed)}`, () => {
      assert.equal(createBeeBridgeQualifier([record()], [record().id])({ ...execution(), ...changed }), false);
    });
  }

  it('captures records and selection before caller mutation', () => {
    const source = record(); const selection = [source.id]; const qualify = createBeeBridgeQualifier([source], selection);
    Object.assign(source, { engineVersion: 'other' }); Object.assign(source.platform, { architecture: 'other' }); selection.length = 0;
    assert.equal(qualify(execution()), true);
  });

  for (const changed of [
    { qualified: true }, { id: '' }, { imageId: 'bee:latest' }, { engineVersion: '' }, { harnessRevision: '' },
    { evidenceDigest: '' }, { bridgeRevision: '' }, { platform: { os: 'linux' } },
    { bridgeLifetimeSeconds: { min: 10, max: 1 } }, { cleanupGraceMs: { min: 0, max: 5000 } },
    { streamBounds: { maxInputBytes: 1 } },
  ]) {
    it(`rejects incomplete or fabricated record fields ${JSON.stringify(changed)}`, () => {
      assert.throws(() => createBeeBridgeQualifier([{ ...record(), ...changed } as BeeBridgeQualificationRecord], [record().id]),
        error => error instanceof Error && error.name === 'ChequebookConfigurationError' && error.cause === undefined);
    });
  }

  it('rejects duplicate qualification ids', () => {
    assert.throws(() => createBeeBridgeQualifier([record(), record()], [record().id]));
  });
});
