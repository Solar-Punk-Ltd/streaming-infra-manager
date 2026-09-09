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
import type { Profile } from '../../src/types/index.js';
import type { ClaimedRolloutDeploy, PreparedRecoveryDeploy, PreparedRolloutDeploy, RolloutAdmissionProof } from '../../src/domain/engineConfig/rolloutDeployAdmission.js';
import { rolloutProfileIdentity } from '../../src/domain/engineConfig/rolloutDeployAdmission.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { targetAlias } from '../../src/domain/ports/DeployTargets.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import { portTableForEngine } from '../../src/domain/versions/enginePortTable.js';
import type { StackVersionRecord, StackVersionRepository } from '../../src/domain/versions/StackVersionRepository.js';
import { captureRolloutRecovery } from '../../src/domain/engineConfig/rolloutRecoveryDescriptor.js';
import { ProfileConfigError } from '../../src/domain/errors/index.js';
import type { InMemoryBuildLedger } from './InMemoryBuildLedger.js';
import type { InMemoryDeployAttempts } from './InMemoryDeployAttempts.js';

interface FixtureDeployments {
  versions: StackVersionRepository;
  versionsRoot: string;
  ledger: InMemoryBuildLedger;
  attempts: InMemoryDeployAttempts;
  daemonId: string;
  onClaim?: (profile: Profile) => void;
}

export class InMemoryEngineConfigOperations implements EngineConfigOperationRepository {
  readonly rows: EngineConfigOperation[] = [];

  /** Thrown by the next findById, once, the way a database that went away throws. */
  failNextRead: Error | null = null;

  private nextId = 1;

  constructor(private readonly profiles: InMemoryProfiles) {}

  deployments?: FixtureDeployments;
  private readonly retainedVersions = new Map<number, StackVersionRecord>();

  private deploymentFixtures(): FixtureDeployments {
    if (!this.deployments) throw new Error('This operation fixture has no deployment admission dependencies.');
    return this.deployments;
  }

  async captureDeployAdmission(profile: Profile): Promise<RolloutAdmissionProof> {
    const d = this.deploymentFixtures();
    const current = this.profiles.rows.get(profile.name);
    if (!current || !isDeepStrictEqual(rolloutProfileIdentity(current), rolloutProfileIdentity(profile))) throw new ProfileConfigError(profile.name, 'The deployment changed before admission.');
    return { alias: targetAlias(profile.host), daemonId: d.daemonId, verifiedAt: 'fixture', inventorySeededAt: 'fixture', daemonInventorySeededAt: 'fixture',
      snapshotToken: await d.attempts.captureSnapshotToken(d.daemonId, profile.name) };
  }

  private async admit(input: Omit<PreparedRolloutDeploy, 'version'>, version: StackVersionRecord) {
    const d = this.deploymentFixtures();
    const current = this.profiles.rows.get(input.profile.name);
    if (!current || !isDeepStrictEqual(rolloutProfileIdentity(current), rolloutProfileIdentity(input.profile))) return null;
    if (!isDeepStrictEqual(await this.captureDeployAdmission(current), input.admission)) throw new ProfileConfigError(current.name, 'The deployment admission changed.');
    if (input.snapshot.daemonId !== d.daemonId || !version.contract) throw new ProfileConfigError(current.name, 'The captured target or contract changed.');
    const ports = portPlanFor(portTableForEngine(version.contract, input.engine), current.port_slot);
    const held = await this.profiles.reservations.holdersOf(d.daemonId, ports, current.name);
    if (held.length) throw new ProfileConfigError(current.name, 'A required port is reserved by another deployment.');
    const attempt = await d.attempts.open({ daemonId: d.daemonId, target: input.admission.alias, project: current.name,
      jobId: `fixture-config-${randomUUID()}`, kind: version.contract.features.sharedImageTags ? 'shared' : 'fixed',
      services: [input.engine], preJobContainerIds: input.snapshot.containerIds, snapshotToken: input.admission.snapshotToken });
    await this.profiles.reservations.plan(d.daemonId, current.name, ports, 'fixture config admission');
    return { attempt, previousStatus: current.status };
  }

  async beginDeploy(input: PreparedRolloutDeploy & { kind: BeginRollout['kind']; config: string | null }): Promise<ClaimedRolloutDeploy | null> {
    const d = this.deploymentFixtures();
    if (!isDeepStrictEqual(await d.versions.findById(input.version.id), input.version)) return null;
    const recovery = await captureRolloutRecovery(input.version, d.versionsRoot);
    const admitted = await this.admit(input, input.version);
    if (!admitted) return null;
    const previous = await this.profiles.engineConfigOf(input.profile.name);
    const begun = (await this.begin({ profileName: input.profile.name, engine: input.engine, kind: input.kind, config: input.config,
      expectedRevision: input.profile.engine_config_revision, previousConfig: previous, previousIsTemplate: previous === null }))!;
    const profile = this.profiles.write(input.profile.name, { status: 'DEPLOYING' })!;
    const descriptor = await d.ledger.seedJob(profile.name, input.version, [input.engine]);
    this.profiles.activeDeployJobs.set(profile.name, descriptor.referenceId!);
    Object.assign(begun.operation, { recoveryDescriptor: recovery, recoveryReferenceId: begun.operation.id,
      deploymentJobReferenceId: descriptor.referenceId });
    this.retainedVersions.set(begun.operation.id, structuredClone(input.version));
    d.onClaim?.(profile);
    return { ...begun, ...admitted, profile, descriptor };
  }

  async seedRecovery(operation: EngineConfigOperation, version: StackVersionRecord): Promise<void> {
    const d = this.deploymentFixtures();
    const descriptor = await d.ledger.seedJob(operation.profileName, version, [operation.engine]);
    Object.assign(operation, { recoveryDescriptor: await captureRolloutRecovery(version, d.versionsRoot), recoveryReferenceId: operation.id,
      deploymentJobReferenceId: descriptor.referenceId });
    this.profiles.activeDeployJobs.set(operation.profileName, descriptor.referenceId!);
    this.retainedVersions.set(operation.id, structuredClone(version));
  }

  private async recover(input: PreparedRecoveryDeploy, explicit: boolean): Promise<ClaimedRolloutDeploy | null> {
    const d = this.deploymentFixtures(), operation = this.owned(input.ownership);
    if (!operation || !(explicit ? ['interrupted'] : ['applying', 'watching', 'reverting']).includes(operation.state)) return null;
    const version = this.retainedVersions.get(operation.id);
    if (!version || operation.recoveryDescriptor?.kind !== 'immutable-build') {
      await this.transition(input.ownership, [operation.state], 'interrupted', { message: 'The saved artifact cannot be verified.' });
      throw new ProfileConfigError(operation.profileName, 'The saved artifact cannot be verified.');
    }
    if (!explicit && this.profiles.activeDeployJobs.get(operation.profileName) !== operation.deploymentJobReferenceId) return null;
    const admitted = await this.admit(input, version);
    if (!admitted) return null;
    let begun: RolloutStarted;
    if (explicit) {
      begun = (await this.begin({ profileName: operation.profileName, engine: operation.engine, kind: 'apply',
        config: operation.previousIsTemplate ? null : operation.previousConfig, expectedRevision: input.profile.engine_config_revision,
        previousConfig: operation.previousConfig, previousIsTemplate: operation.previousIsTemplate }))!;
      Object.assign(begun.operation, { kind: 'restore-previous', sourceOperationId: operation.id, state: 'reverting',
        recoveryDescriptor: operation.recoveryDescriptor, recoveryReferenceId: begun.operation.id });
      this.retainedVersions.set(begun.operation.id, version);
    } else begun = (await this.beginRevert(input.ownership, input.message))!;
    const profile = this.profiles.write(input.profile.name, { status: 'DEPLOYING', engine_config_state: 'reverting' })!;
    const descriptor = await d.ledger.seedJob(profile.name, version, [input.engine]);
    this.profiles.activeDeployJobs.set(profile.name, descriptor.referenceId!);
    begun.operation.deploymentJobReferenceId = descriptor.referenceId;
    d.onClaim?.(profile);
    return { ...begun, ...admitted, profile, descriptor };
  }

  beginRevertDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null> { return this.recover(input, false); }
  beginRestorePreviousDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null> { return this.recover(input, true); }

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
        row.message = `Superseded by a new ${input.kind}.`;
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
      recoveryDescriptor: null,
      recoveryReferenceId: null,
      deploymentJobReferenceId: null,
      sourceOperationId: null,
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
    // As the SQL does with COALESCE: a patch field left out or null keeps the column.
    const given = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== null),
    );
    Object.assign(operation, given, { state: to });
    if (!OPEN_OPERATION_STATES.includes(to) || to === 'interrupted') operation.finishedAt = new Date();
    this.profiles.write(operation.profileName, {
      engine_config_state: to,
      ...(to === 'applied' ? { engine_config_error: null } : {}),
      ...(patch.message == null ? {} : { engine_config_error: patch.message }),
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
