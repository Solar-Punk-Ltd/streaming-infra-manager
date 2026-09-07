import type { EngineName } from '@streaming-infra-manager/common';

/**
 * Where a config file rollout stands. The open states hold the one open
 * operation per deployment instance, so a second rollout has to supersede
 * the first before it stores anything.
 */
export type EngineConfigOperationState =
  | 'applying'
  | 'watching'
  | 'applied'
  | 'reverting'
  | 'reverted'
  | 'failed'
  | 'interrupted'
  | 'superseded';

export const OPEN_OPERATION_STATES: readonly EngineConfigOperationState[] = [
  'applying',
  'watching',
  'reverting',
  'interrupted',
];

export type EngineConfigOperationKind = 'apply' | 'reset';

export interface EngineConfigOperation {
  id: number;
  profileName: string;
  /** The deployment as it was when the rollout started. A removed and recreated name is another instance. */
  profileInstanceId: string;
  engine: EngineName;
  kind: EngineConfigOperationKind;
  /** The file to put back on failure, null for the template when `previousIsTemplate`. */
  previousConfig: string | null;
  previousIsTemplate: boolean;
  /** The config revision this rollout's own write produced. */
  appliedRevision: number;
  /** The intent the rollout was started under. A moved intent ends it without a write. */
  intentRevision: number;
  state: EngineConfigOperationState;
  /** The container the watch verified, recorded when the watch started. */
  containerId: string | null;
  containerStartedAt: string | null;
  startedAt: Date;
  recreateFinishedAt: Date | null;
  watchStartedAt: Date | null;
  finishedAt: Date | null;
  message: string | null;
}

/** What every conditional write of a rollout checks together. */
export interface RolloutOwnership {
  operationId: number;
  profileInstanceId: string;
  appliedRevision: number;
  intentRevision: number;
}

export function ownershipOf(operation: EngineConfigOperation): RolloutOwnership {
  return {
    operationId: operation.id,
    profileInstanceId: operation.profileInstanceId,
    appliedRevision: operation.appliedRevision,
    intentRevision: operation.intentRevision,
  };
}
