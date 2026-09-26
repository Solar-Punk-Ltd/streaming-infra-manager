import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import type { DockerBeeAcquisitionOptions } from './acquireDockerBeeStream.js';
import { beeBridgeCheckEvidence } from './beeBridgeCheck.js';
import { beeBridgeTuple, createBeeBridgeQualifier, type BeeBridgeExecution, type BeeBridgeQualificationRecord,
  type QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';
import type { BeeBridgeQualificationStore } from './BeeBridgeQualificationStore.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { probeDockerBeeBridge, type BeeBridgeProbe } from './probeDockerBeeBridge.js';

/**
 * Qualification for a route that pins no qualification ids. The seed catalog
 * and the passes the manager stored qualify a tuple, and a tuple neither covers
 * is checked on a connection of its own before the bridge's acquisition begins.
 */
export interface AutomaticBeeBridgeQualification {
  readonly kind: 'automatic';
  /** Reads, checks when needed and stores, then answers the qualifier the bridge's own connection must pass before its exec. */
  probe(connection: Duplex, target: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions, signal?: AbortSignal,
    acquisitionDeadline?: number): Promise<QualifiedBeeBridgeExecution>;
}

export function isAutomaticBeeBridgeQualification(value: unknown): value is AutomaticBeeBridgeQualification {
  return !!value && typeof value === 'object' && (value as AutomaticBeeBridgeQualification).kind === 'automatic';
}

export function automaticBeeBridgeQualification(catalog: readonly BeeBridgeQualificationRecord[], store: BeeBridgeQualificationStore): AutomaticBeeBridgeQualification {
  const seed = createBeeBridgeQualifier(catalog, catalog.map(record => record.id));

  async function storedPass(execution: BeeBridgeExecution): Promise<BeeBridgeQualificationRecord | null> {
    try { return await store.passFor(beeBridgeTuple(execution)); }
    catch { throw new DockerBeeAcquisitionError('unavailable'); }
  }

  /** The seed or a stored pass covers this exact execution, within the catalog's own bounds. */
  async function qualifies(execution: BeeBridgeExecution): Promise<boolean> {
    if (seed(execution) === true) return true;
    const pass = await storedPass(execution);
    return !!pass && createBeeBridgeQualifier([pass], [pass.id])(execution) === true;
  }

  async function recordCheck(probe: BeeBridgeProbe, hostAlias: string): Promise<void> {
    if (!probe.verdict) return;
    const tuple = beeBridgeTuple(probe.observed.execution);
    try { await store.record({ tuple, failedCheck: probe.verdict.failed, evidence: beeBridgeCheckEvidence(tuple, probe.verdict), hostAlias }); }
    catch { throw new DockerBeeAcquisitionError('unavailable'); }
  }

  return Object.freeze({
    kind: 'automatic' as const,
    async probe(connection: Duplex, target: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions, signal?: AbortSignal, acquisitionDeadline?: number) {
      const probe = await probeDockerBeeBridge(connection, target, options, async execution => !await qualifies(execution), signal, acquisitionDeadline);
      await recordCheck(probe, target.alias);
      const checked = probe.observed;
      const failed = probe.verdict?.failed ?? null;
      return async (execution: BeeBridgeExecution, container?: { readonly containerId: string }) => {
        if (container?.containerId !== checked.containerId || !isDeepStrictEqual(beeBridgeTuple(execution), beeBridgeTuple(checked.execution))) {
          throw new DockerBeeAcquisitionError('target_changed');
        }
        if (await qualifies(execution)) return true;
        throw failed ? new DockerBeeAcquisitionError('bridge_not_qualified', failed) : new DockerBeeAcquisitionError('unavailable');
      };
    },
  });
}
