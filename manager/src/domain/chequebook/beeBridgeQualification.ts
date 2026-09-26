import { isDeepStrictEqual } from 'node:util';
import { ChequebookConfigurationError } from '../errors/ChequebookConfigurationError.js';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { dockerObject, type ObservedBeeContainer } from './DockerBeeBinding.js';
import { DOCKER_BEE_BRIDGE_REVISION } from './dockerBeeBridge.js';

export const DOCKER_BEE_STREAM_BOUNDS = Object.freeze({ maxFrameBytes: 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024, maxInputBytes: 64 * 1024 });
interface BeeImagePlatform { readonly os: string; readonly architecture: string; readonly variant: string }
interface QualifiedRange { readonly min: number; readonly max: number }
export interface BeeBridgeExecution {
  readonly imageId: string;
  readonly engineVersion: string;
  readonly platform: BeeImagePlatform;
  readonly bridgeRevision: string;
  readonly bridgeLifetimeSeconds: number;
  readonly cleanupGraceMs: number;
  readonly streamBounds: typeof DOCKER_BEE_STREAM_BOUNDS;
}
export interface BeeBridgeQualificationRecord extends Omit<BeeBridgeExecution, 'bridgeLifetimeSeconds' | 'cleanupGraceMs'> {
  readonly id: string;
  readonly harnessRevision: string;
  readonly evidenceDigest: string;
  readonly bridgeLifetimeSeconds: QualifiedRange;
  readonly cleanupGraceMs: QualifiedRange;
}
/** The facts a qualification is about: the image, the Docker engine, the platform and the bridge script. */
export type BeeBridgeTuple = Pick<BeeBridgeExecution, 'imageId' | 'engineVersion' | 'platform' | 'bridgeRevision'>;
/**
 * Whether the bridge may run for this exact execution in this container. It may
 * throw a DockerBeeAcquisitionError naming a more exact cause than a plain no.
 */
export type QualifiedBeeBridgeExecution = (execution: BeeBridgeExecution, container?: ObservedBeeContainer) => boolean | Promise<boolean>;

export function beeBridgeTuple(execution: BeeBridgeExecution): BeeBridgeTuple {
  return Object.freeze({ imageId: execution.imageId, engineVersion: execution.engineVersion,
    platform: Object.freeze({ os: execution.platform.os, architecture: execution.platform.architecture, variant: execution.platform.variant }),
    bridgeRevision: execution.bridgeRevision });
}

/** The lifetime, grace and stream bounds every record qualifies within: the seed's, and every pass the manager stores. */
const QUALIFIED_BRIDGE_LIFETIME_SECONDS = Object.freeze({ min: 1, max: 270 });
const QUALIFIED_CLEANUP_GRACE_MS = Object.freeze({ min: 1, max: 10_000 });

/** A pass the manager stored itself, as a record the same qualifier reads. */
export function storedPassRecord(pass: { readonly id: string; readonly tuple: BeeBridgeTuple; readonly harnessRevision: string; readonly evidenceDigest: string }): BeeBridgeQualificationRecord {
  const { imageId, engineVersion, platform, bridgeRevision } = pass.tuple;
  return Object.freeze({ id: pass.id, imageId, engineVersion, bridgeRevision,
    platform: Object.freeze({ os: platform.os, architecture: platform.architecture, variant: platform.variant }),
    harnessRevision: pass.harnessRevision, evidenceDigest: pass.evidenceDigest,
    bridgeLifetimeSeconds: QUALIFIED_BRIDGE_LIFETIME_SECONDS, cleanupGraceMs: QUALIFIED_CLEANUP_GRACE_MS, streamBounds: DOCKER_BEE_STREAM_BOUNDS });
}

/**
 * The seed: images checked by hand before the manager checked them itself, one
 * entry per image and Docker engine pair. Synthetic records are injected by
 * tests. On a route that pins no qualification ids, an image no entry covers
 * is checked automatically the first time a transfer goes through it and the
 * pass is stored in bee_bridge_qualifications, so there this list only saves
 * that first check. A route that pins ids is qualified by the entries it names
 * and nothing else.
 *
 * The one entry was produced by `manager/scripts/qualify-bee-bridge.mjs` on
 * 2026-09-14. Its `harnessRevision` is the git object id the script had then,
 * kept as history. A pass the manager stores carries BEE_BRIDGE_CHECK_REVISION
 * instead, a hash of the check's own definition. `evidenceDigest` is the hash
 * of what the check saw. An entry is about the image, never the container.
 *
 * An entry stops matching the moment anything it pins moves, the image, the
 * Docker engine, the platform or the bridge script itself.
 */
export const PRODUCTION_BEE_BRIDGE_QUALIFICATIONS: readonly BeeBridgeQualificationRecord[] = Object.freeze([
  Object.freeze({
    // ethersphere/bee:2.8.2 as it runs on 157.90.34.105, qualified 2026-09-14.
    id: 'bee-2.8.2-docker-29.1.3',
    imageId: 'sha256:b97defc2c32cdc72bfefccd73fc5b4615d0f78d56f3f701dcd2a17029edccab4',
    engineVersion: '29.1.3',
    platform: Object.freeze({ os: 'linux', architecture: 'amd64', variant: '' }),
    bridgeRevision: DOCKER_BEE_BRIDGE_REVISION,
    harnessRevision: 'ce9ef1a6b01273c4eb2759ba0ea32f01416356f0',
    evidenceDigest: 'sha256:ff368ea1c36ab4700c61cf32e46015d3de7fc40a4d5e3ba4cfc02c34fbfc0d43',
    bridgeLifetimeSeconds: QUALIFIED_BRIDGE_LIFETIME_SECONDS,
    cleanupGraceMs: QUALIFIED_CLEANUP_GRACE_MS,
    streamBounds: DOCKER_BEE_STREAM_BOUNDS,
  }),
]);
const HASH = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/;
const PLATFORM = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function platform(value: unknown): BeeImagePlatform {
  const object = dockerObject(value);
  if (Object.keys(object).sort().join(',') !== 'architecture,os,variant' || typeof object.os !== 'string' || !PLATFORM.test(object.os) ||
      typeof object.architecture !== 'string' || !PLATFORM.test(object.architecture) || typeof object.variant !== 'string' ||
      (object.variant !== '' && !PLATFORM.test(object.variant))) throw new DockerBeeAcquisitionError();
  return Object.freeze({ os: object.os, architecture: object.architecture, variant: object.variant });
}
function range(value: unknown, maximum: number): QualifiedRange {
  const object = dockerObject(value);
  if (Object.keys(object).sort().join(',') !== 'max,min' || !Number.isSafeInteger(object.min) || !Number.isSafeInteger(object.max) ||
      Number(object.min) < 1 || Number(object.max) < Number(object.min) || Number(object.max) > maximum) throw new ChequebookConfigurationError();
  return Object.freeze({ min: Number(object.min), max: Number(object.max) });
}
export function dockerEngineVersion(info: unknown): string {
  const value = dockerObject(info).ServerVersion;
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new DockerBeeAcquisitionError();
  return value;
}

/** Only facts read on the already owned Docker connection qualify its exact bridge execution. */
export function observedBeeBridgeExecution(engineVersion: string, image: unknown, expectedImageId: string,
  bridgeLifetimeMs: number, cleanupGraceMs: number): BeeBridgeExecution {
  const object = dockerObject(image);
  if (!HASH.test(expectedImageId) || object.Id !== expectedImageId || !TOKEN.test(engineVersion) || !Number.isFinite(bridgeLifetimeMs) ||
      bridgeLifetimeMs <= 0 || bridgeLifetimeMs > 270_000 || !Number.isSafeInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 10_000) throw new DockerBeeAcquisitionError();
  return Object.freeze({ imageId: expectedImageId, engineVersion,
    platform: platform({ os: object.Os, architecture: object.Architecture, variant: object.Variant === undefined ? '' : object.Variant }),
    bridgeRevision: DOCKER_BEE_BRIDGE_REVISION, bridgeLifetimeSeconds: Math.ceil(bridgeLifetimeMs / 1000), cleanupGraceMs,
    streamBounds: DOCKER_BEE_STREAM_BOUNDS });
}

/** Runtime selection cannot invent qualification. Missing IDs and an empty catalog simply refuse execution. */
export function createBeeBridgeQualifier(records: readonly BeeBridgeQualificationRecord[] = PRODUCTION_BEE_BRIDGE_QUALIFICATIONS,
  selectedIds: readonly string[] = []): QualifiedBeeBridgeExecution {
  try {
    const copied = structuredClone(records); const selected = structuredClone(selectedIds);
    if (!Array.isArray(copied) || copied.length > 256 || !Array.isArray(selected) || selected.length > 256 || selected.some(id => typeof id !== 'string' || !TOKEN.test(id))) throw new ChequebookConfigurationError();
    const catalog = new Map<string, Readonly<BeeBridgeQualificationRecord>>();
    for (const input of copied) {
      const value = dockerObject(input);
      if (Object.keys(value).sort().join(',') !== 'bridgeLifetimeSeconds,bridgeRevision,cleanupGraceMs,engineVersion,evidenceDigest,harnessRevision,id,imageId,platform,streamBounds' ||
          typeof value.id !== 'string' || !TOKEN.test(value.id) || catalog.has(value.id) || typeof value.imageId !== 'string' || !HASH.test(value.imageId) ||
          typeof value.engineVersion !== 'string' || !TOKEN.test(value.engineVersion) || typeof value.bridgeRevision !== 'string' || !HASH.test(value.bridgeRevision) ||
          typeof value.evidenceDigest !== 'string' || !HASH.test(value.evidenceDigest) || typeof value.harnessRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(value.harnessRevision) ||
          !isDeepStrictEqual(value.streamBounds, DOCKER_BEE_STREAM_BOUNDS)) throw new ChequebookConfigurationError();
      catalog.set(value.id, Object.freeze({ id: value.id, imageId: value.imageId, engineVersion: value.engineVersion,
        bridgeRevision: value.bridgeRevision, evidenceDigest: value.evidenceDigest, harnessRevision: value.harnessRevision,
        platform: platform(value.platform), streamBounds: DOCKER_BEE_STREAM_BOUNDS,
        bridgeLifetimeSeconds: range(value.bridgeLifetimeSeconds, 270), cleanupGraceMs: range(value.cleanupGraceMs, 10_000) }));
    }
    const permitted = selected.map(id => catalog.get(id)).filter((value): value is Readonly<BeeBridgeQualificationRecord> => !!value);
    return input => {
      try {
        const value = structuredClone(input);
        return permitted.some(record => value.imageId === record.imageId && value.engineVersion === record.engineVersion &&
          value.bridgeRevision === record.bridgeRevision && value.bridgeRevision === DOCKER_BEE_BRIDGE_REVISION &&
          isDeepStrictEqual(value.platform, record.platform) && isDeepStrictEqual(value.streamBounds, record.streamBounds) &&
          Number.isSafeInteger(value.bridgeLifetimeSeconds) && value.bridgeLifetimeSeconds >= record.bridgeLifetimeSeconds.min && value.bridgeLifetimeSeconds <= record.bridgeLifetimeSeconds.max &&
          Number.isSafeInteger(value.cleanupGraceMs) && value.cleanupGraceMs >= record.cleanupGraceMs.min && value.cleanupGraceMs <= record.cleanupGraceMs.max);
      } catch { return false; }
    };
  } catch { throw new ChequebookConfigurationError(); }
}
