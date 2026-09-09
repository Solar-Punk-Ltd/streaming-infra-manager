import { isDeepStrictEqual } from 'node:util';
import type { BundledShipmentReceipt } from './BundledShipment.js';
import { ManagerUpgradeGuard } from './managerUpgradeGuard.js';

export interface ManagerUpgradeRequest {
  shipment: { shipmentId: string; commit: string; digest: string };
  manager: { sourceCommit: string; sourceDigest: string; imageId: string };
  project: string;
}
export interface ManagerPublication {
  revision: string;
  buildId: string | null;
  receipt: BundledShipmentReceipt | null;
}
/** Operations use the exact staged image/source and one Compose project. Each command has its own bounded supervisor.
 * readPublication also verifies the shipment journal's commit and digest against the captured request. */
export interface ManagerUpgradeOperations {
  readPublication(request: ManagerUpgradeRequest): Promise<ManagerPublication>;
  stopApi(request: ManagerUpgradeRequest): Promise<void>;
  installSources(request: ManagerUpgradeRequest): Promise<void>;
  publish(request: ManagerUpgradeRequest): Promise<BundledShipmentReceipt>;
  startProject(request: ManagerUpgradeRequest): Promise<void>;
  verifyProject(request: ManagerUpgradeRequest): Promise<void>;
}
export interface ManagerUpgradeResult { state: 'completed' | 'already-completed'; receipt: BundledShipmentReceipt }
interface CompletedUpgrade { schema: 1; request: ManagerUpgradeRequest; receipt: BundledShipmentReceipt }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;

function captureRequest(input: ManagerUpgradeRequest): ManagerUpgradeRequest {
  const request = structuredClone(input);
  const fields = (value: unknown, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), keys.sort());
  const matches = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
  if (!fields(request, ['shipment', 'manager', 'project']) || !fields(request.shipment, ['shipmentId', 'commit', 'digest']) ||
    !fields(request.manager, ['sourceCommit', 'sourceDigest', 'imageId']) ||
    !matches(request.shipment.shipmentId, UUID) || !matches(request.shipment.commit, COMMIT) ||
    !matches(request.shipment.digest, DIGEST) || !matches(request.manager.sourceCommit, COMMIT) ||
    !matches(request.manager.sourceDigest, DIGEST) || !matches(request.manager.imageId, /^sha256:[a-f0-9]{64}$/) ||
    !matches(request.project, /^[a-z0-9][a-z0-9_-]{0,62}$/)) throw new Error('Invalid manager upgrade identity fields.');
  Object.freeze(request.shipment); Object.freeze(request.manager); return Object.freeze(request);
}
function receiptOf(value: unknown, request: ManagerUpgradeRequest): BundledShipmentReceipt {
  if (!value || typeof value !== 'object') throw new Error('Manager publication receipt cannot be verified.');
  const receipt = value as BundledShipmentReceipt;
  if (receipt.shipmentId !== request.shipment.shipmentId || !Number.isSafeInteger(receipt.versionId) || receipt.versionId < 1 ||
      typeof receipt.buildId !== 'string' || !/^[a-f0-9]{7,64}(?:-r[1-9][0-9]*)?$/.test(receipt.buildId) ||
      typeof receipt.publicationRevision !== 'string' || !REVISION.test(receipt.publicationRevision) ||
      !Number.isFinite(new Date(receipt.publishedAt).getTime())) throw new Error('Manager publication receipt cannot be verified.');
  return { ...receipt, publishedAt: new Date(receipt.publishedAt) };
}
function assertCurrent(publication: ManagerPublication, receipt: BundledShipmentReceipt): void {
  if (typeof publication.revision !== 'string' || !REVISION.test(publication.revision) ||
      publication.revision !== receipt.publicationRevision || publication.buildId !== receipt.buildId) {
    throw new Error('This manager upgrade is stale. Its receipt is not the current publication.');
  }
}

/** Uncertain creators retain the durable guard. Neither elapsed time nor same-ID replay can launch them again. */
export async function runManagerUpgrade(environment: { guardRoot: string; mutableRoot: string }, input: ManagerUpgradeRequest,
  operations: ManagerUpgradeOperations): Promise<ManagerUpgradeResult> {
  const request = captureRequest(input);
  const guard = new ManagerUpgradeGuard(environment.guardRoot, environment.mutableRoot);
  guard.acquire(request);
  let effectStarted = false;
  try {
    const current = await operations.readPublication(request);
    if (typeof current.revision !== 'string' || !REVISION.test(current.revision)) throw new Error('Current manager publication cannot be verified.');
    const completed = guard.completed(request.shipment.shipmentId) as CompletedUpgrade | null;
    if (completed && (completed.schema !== 1 || !isDeepStrictEqual(completed.request, request))) throw new Error('Completed manager upgrade identity does not match.');
    if (current.receipt) {
      const receipt = receiptOf(current.receipt, request); assertCurrent(current, receipt);
      if (!completed || !isDeepStrictEqual(receiptOf(completed.receipt, request), receipt)) {
        throw new Error('Manager upgrade completion is unverified. Resolve its retained ownership before continuing.');
      }
      guard.release(); return { state: 'already-completed', receipt };
    }
    if (completed) throw new Error('Completed manager upgrade publication cannot be verified.');
    guard.phase('stopping'); effectStarted = true; await operations.stopApi(request);
    guard.phase('installing'); await operations.installSources(request);
    guard.phase('publishing'); const receipt = receiptOf(await operations.publish(request), request);
    assertCurrent(await operations.readPublication(request), receipt);
    guard.phase('starting'); await operations.startProject(request);
    guard.phase('verifying'); await operations.verifyProject(request);
    assertCurrent(await operations.readPublication(request), receipt);
    guard.complete(request.shipment.shipmentId, { schema: 1, request, receipt });
    guard.release(); return { state: 'completed', receipt };
  } catch (error) {
    if (!effectStarted) guard.release();
    throw error;
  }
}
