import type { EngineName } from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';

import type {
  EngineConfigOperation,
  EngineConfigOperationKind,
  EngineConfigOperationState,
  RolloutOwnership,
} from './operations.js';

export interface BeginRollout {
  profileName: string;
  engine: EngineName;
  kind: Exclude<EngineConfigOperationKind, 'restore-previous'>;
  /** The file to store, null for the template. */
  config: string | null;
  /** The config revision the caller read. The write happens only while it is current. */
  expectedRevision: number;
  previousConfig: string | null;
  previousIsTemplate: boolean;
}

export interface RolloutStarted {
  profile: Profile;
  operation: EngineConfigOperation;
}

/**
 * The rows a config file rollout owns, and the writes that keep ownership
 * explicit. Every write that acts on a rollout is conditional on the
 * operation's state, the deployment instance, the config revision and the
 * intent revision together, and answers null when any of them moved.
 */
export interface EngineConfigOperationRepository {
  /**
   * One transaction: the instance's open operation becomes superseded, the
   * file is stored under the expected revision with the intent bumped, and
   * the new operation is recorded as applying. Null when the row moved or is
   * gone, and then nothing was written.
   */
  begin(input: BeginRollout): Promise<RolloutStarted | null>;
  findById(id: number): Promise<EngineConfigOperation | null>;
  findOpen(profileInstanceId: string): Promise<EngineConfigOperation | null>;
  listOpen(): Promise<EngineConfigOperation[]>;
  /** For stop and removal: the instance's open operation is over, durably. */
  supersedeOpen(profileInstanceId: string, message: string): Promise<void>;
  /** A state change of the operation alone, conditional on ownership and on `from`. */
  transition(
    ownership: RolloutOwnership,
    from: readonly EngineConfigOperationState[],
    to: EngineConfigOperationState,
    patch?: Partial<
      Pick<
        EngineConfigOperation,
        'message' | 'containerId' | 'containerStartedAt' | 'recreateFinishedAt' | 'watchStartedAt'
      >
    >,
  ): Promise<EngineConfigOperation | null>;
  /**
   * One transaction: while the rollout still owns the deployment, the
   * previous file goes back under the applied revision and the operation
   * becomes reverting with the reason. Null when ownership was lost, and then
   * nothing was written.
   */
  beginRevert(ownership: RolloutOwnership, message: string): Promise<RolloutStarted | null>;
}
