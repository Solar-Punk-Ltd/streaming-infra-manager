/**
 * The operations table and the profile columns a rollout owns, over a Map,
 * with the conditional writes the real repository makes in SQL.
 */
import type {
  BeginRollout,
  EngineConfigOperationRepository,
  RolloutStarted,
} from '../../src/domain/engineConfig/EngineConfigOperationRepository.js';
import {
  type EngineConfigOperation,
  type EngineConfigOperationState,
  OPEN_OPERATION_STATES,
  type RolloutOwnership,
} from '../../src/domain/engineConfig/operations.js';

import type { InMemoryProfiles } from './profileFixtures.js';

export class InMemoryEngineConfigOperations implements EngineConfigOperationRepository {
  readonly rows: EngineConfigOperation[] = [];

  /** Thrown by the next findById, once, the way a database that went away throws. */
  failNextRead: Error | null = null;

  private nextId = 1;

  constructor(private readonly profiles: InMemoryProfiles) {}

  private owned(ownership: RolloutOwnership): EngineConfigOperation | null {
    const operation = this.rows.find((row) => row.id === ownership.operationId);
    if (!operation) return null;
    const profile = this.profiles.rows.get(operation.profileName);
    if (!profile) return null;
    if (
      profile.instance_id !== ownership.profileInstanceId ||
      profile.engine_config_revision !== ownership.appliedRevision ||
      profile.intent_revision !== ownership.intentRevision
    ) {
      return null;
    }
    return operation;
  }

  async begin(input: BeginRollout): Promise<RolloutStarted | null> {
    const profile = this.profiles.rows.get(input.profileName);
    if (!profile || profile.engine_config_revision !== input.expectedRevision) return null;
    for (const row of this.rows) {
      if (row.profileInstanceId === profile.instance_id && OPEN_OPERATION_STATES.includes(row.state)) {
        row.state = 'superseded';
        row.finishedAt = new Date();
        row.message = `superseded by a new ${input.kind}`;
      }
    }
    const stored = await this.profiles.setEngineConfig(input.profileName, input.config, null);
    if (!stored) return null;
    const written = this.profiles.write(input.profileName, {
      engine_config_revision: profile.engine_config_revision + 1,
      intent_revision: profile.intent_revision + 1,
      engine_config_state: 'applying',
    });
    if (!written) return null;
    const operation: EngineConfigOperation = {
      id: this.nextId++,
      profileName: input.profileName,
      profileInstanceId: written.instance_id,
      engine: input.engine,
      kind: input.kind,
      previousConfig: input.previousConfig,
      previousIsTemplate: input.previousIsTemplate,
      appliedRevision: written.engine_config_revision,
      intentRevision: written.intent_revision,
      state: 'applying',
      containerId: null,
      containerStartedAt: null,
      startedAt: new Date(),
      recreateFinishedAt: null,
      watchStartedAt: null,
      finishedAt: null,
      message: null,
    };
    this.rows.push(operation);
    return { profile: written, operation };
  }

  async findById(id: number): Promise<EngineConfigOperation | null> {
    if (this.failNextRead) {
      const failure = this.failNextRead;
      this.failNextRead = null;
      throw failure;
    }
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findOpen(profileInstanceId: string): Promise<EngineConfigOperation | null> {
    return (
      this.rows.find(
        (row) => row.profileInstanceId === profileInstanceId && OPEN_OPERATION_STATES.includes(row.state),
      ) ?? null
    );
  }

  async listOpen(): Promise<EngineConfigOperation[]> {
    return this.rows.filter((row) => OPEN_OPERATION_STATES.includes(row.state));
  }

  async supersedeOpen(profileInstanceId: string, message: string): Promise<void> {
    for (const row of this.rows) {
      if (row.profileInstanceId === profileInstanceId && OPEN_OPERATION_STATES.includes(row.state)) {
        row.state = 'superseded';
        row.finishedAt = new Date();
        row.message = message;
        this.profiles.write(row.profileName, {
          engine_config_state: 'superseded',
          engine_config_error: message,
        });
      }
    }
  }

  async transition(
    ownership: RolloutOwnership,
    from: readonly EngineConfigOperationState[],
    to: EngineConfigOperationState,
    patch: Partial<EngineConfigOperation> = {},
  ): Promise<EngineConfigOperation | null> {
    const operation = this.owned(ownership);
    if (!operation || !from.includes(operation.state)) return null;
    Object.assign(operation, patch, { state: to });
    if (!OPEN_OPERATION_STATES.includes(to) || to === 'interrupted') operation.finishedAt = new Date();
    this.profiles.write(operation.profileName, {
      engine_config_state: to,
      ...(to === 'applied' ? { engine_config_error: null } : {}),
      ...(patch.message === undefined ? {} : { engine_config_error: patch.message }),
    });
    return operation;
  }

  async beginRevert(ownership: RolloutOwnership, message: string): Promise<RolloutStarted | null> {
    const operation = this.owned(ownership);
    if (!operation || !['watching', 'applying', 'reverting'].includes(operation.state)) return null;
    const profile = await this.profiles.setEngineConfig(
      operation.profileName,
      operation.previousIsTemplate ? null : operation.previousConfig,
      message,
    );
    if (!profile) return null;
    const written = this.profiles.write(operation.profileName, {
      engine_config_revision: profile.engine_config_revision + 1,
      engine_config_state: 'reverting',
    });
    if (!written) return null;
    Object.assign(operation, {
      state: 'reverting',
      message,
      appliedRevision: written.engine_config_revision,
    });
    return { profile: written, operation };
  }
}
