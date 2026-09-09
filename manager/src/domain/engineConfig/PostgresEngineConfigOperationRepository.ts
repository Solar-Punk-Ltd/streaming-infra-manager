import type { EngineName } from '@streaming-infra-manager/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Pool, PoolClient } from 'pg';

import { Profile } from '../../types/index.js';
import { DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL, PROFILE_COLUMNS } from '../profileSql.js';
import { ProfileConfigError } from '../errors/index.js';
import { insertOwnedBuildJob } from '../versions/buildJobClaim.js';
import { captureRolloutAdmission, lockRolloutDeploy, lockRolloutPrefix, planLockedRollout, reserveRolloutDeploy, rolloutProfileIdentity,
  type ClaimedRolloutDeploy, type PreparedRecoveryDeploy, type PreparedRolloutDeploy, type RolloutAdmissionProof } from './rolloutDeployAdmission.js';
import { captureRolloutRecovery, parseRolloutRecoveryDescriptor, validateCapturedRecovery,
  type RolloutRecoveryCapture, type RolloutRecoveryDescriptor } from './rolloutRecoveryDescriptor.js';
import { versionRemovalProblem } from '../versions/versionRemovalMarker.js';

import type {
  BeginRollout,
  EngineConfigOperationRepository,
  RolloutStarted,
} from './EngineConfigOperationRepository.js';
import {
  type EngineConfigOperation,
  type EngineConfigOperationKind,
  type EngineConfigOperationState,
  OPEN_OPERATION_STATES,
  type RolloutOwnership,
} from './operations.js';

const OPERATION_COLUMNS = `
  id, profile_name, profile_instance_id, engine, kind,
  previous_config, previous_is_template, applied_revision, intent_revision, state,
  container_id, container_started_at,
  started_at, recreate_finished_at, watch_started_at, finished_at, message,
  recovery_descriptor, recovery_reference_id, deployment_job_reference_id, source_operation_id
`;

interface OperationRow {
  id: number;
  profile_name: string;
  profile_instance_id: string;
  engine: EngineName;
  kind: EngineConfigOperationKind;
  previous_config: string | null;
  previous_is_template: boolean;
  applied_revision: number;
  intent_revision: number;
  state: EngineConfigOperationState;
  container_id: string | null;
  container_started_at: string | null;
  started_at: Date;
  recreate_finished_at: Date | null;
  watch_started_at: Date | null;
  finished_at: Date | null;
  message: string | null;
  recovery_descriptor: unknown;
  recovery_reference_id: number | null;
  deployment_job_reference_id: number | null;
  source_operation_id: number | null;
}

interface RecoveryProfile extends Profile { deploy_job_reference_id: number | null }
interface RecoveryReference {
  id: number; version_id: number; build_id: string; holder_kind: string; holder_id: string;
  services: string[]; profile_instance_id: string | null; intent_revision: number | null; resolved_at: Date | null;
}
interface RecoveryLocator {
  operation: OperationRow;
  profile: RecoveryProfile;
  descriptor: RolloutRecoveryDescriptor | null;
  versionIds: number[];
  problem: string | null;
}
const RECOVERY_REFERENCE_COLUMNS = 'id, version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision, resolved_at';
const AUTOMATIC_RECOVERY_STATES: readonly EngineConfigOperationState[] = ['applying', 'watching', 'reverting'];
const UNVERIFIED_RECOVERY = 'This rollout has no verified immutable recovery artifact. Review the interrupted rollout before restoring the previous configuration.';
const CHANGED_RECOVERY = 'The saved recovery ownership or artifact evidence changed. Review the interrupted rollout before restoring the previous configuration.';

function toOperation(row: OperationRow): EngineConfigOperation {
  return {
    id: row.id,
    profileName: row.profile_name,
    profileInstanceId: row.profile_instance_id,
    engine: row.engine,
    kind: row.kind,
    previousConfig: row.previous_config,
    previousIsTemplate: row.previous_is_template,
    appliedRevision: row.applied_revision,
    intentRevision: row.intent_revision,
    state: row.state,
    containerId: row.container_id,
    containerStartedAt: row.container_started_at,
    startedAt: row.started_at,
    recreateFinishedAt: row.recreate_finished_at,
    watchStartedAt: row.watch_started_at,
    finishedAt: row.finished_at,
    message: row.message,
    recoveryDescriptor: parseRolloutRecoveryDescriptor(row.recovery_descriptor),
    recoveryReferenceId: row.recovery_reference_id,
    deploymentJobReferenceId: row.deployment_job_reference_id,
    sourceOperationId: row.source_operation_id,
  };
}

/** A state that ends the rollout's activity, so the operation records when. */
function closes(state: EngineConfigOperationState): boolean {
  return !OPEN_OPERATION_STATES.includes(state) || state === 'interrupted';
}

/**
 * The rollout rows in Postgres.
 *
 * Every write that acts on a rollout runs in a transaction that locks the
 * profile row first and the operation row second, in that order everywhere,
 * so two writers on one deployment serialise rather than deadlock, and the
 * ownership check reads the row it is about to write.
 */
export class PostgresEngineConfigOperationRepository
  implements EngineConfigOperationRepository
{
  constructor(
    private readonly pool: Pool,
    private readonly versionsRoot?: string,
    private readonly captureRecovery: RolloutRecoveryCapture = captureRolloutRecovery,
  ) {}

  async captureDeployAdmission(profile: Profile): Promise<RolloutAdmissionProof> {
    const expected = structuredClone(profile);
    return this.inTransaction(client => captureRolloutAdmission(client, expected));
  }

  async beginDeploy(input: PreparedRolloutDeploy & { kind: Exclude<EngineConfigOperationKind, 'restore-previous'>; config: string | null }): Promise<ClaimedRolloutDeploy | null> {
    const request = structuredClone(input);
    const versionsRoot = this.requireVersionsRoot(request.profile.name);
    if (request.kind === 'reset' && request.config !== null) throw new ProfileConfigError(request.profile.name, 'A reset must select the engine template.');
    const recovery = await this.captureRecovery(request.version, versionsRoot);
    return this.inTransaction(async client => {
      const locked = await lockRolloutDeploy(client, request, `config-${randomUUID()}`);
      if (!locked) return null;
      validateCapturedRecovery(recovery, request.version, versionsRoot);
      const previous = (await client.query<{ engine_config: string | null }>('SELECT engine_config FROM profiles WHERE name = $1', [locked.profile.name])).rows[0]!.engine_config;
      const attempt = await reserveRolloutDeploy(client, locked);
      await client.query(
        `UPDATE engine_config_operations SET state = 'superseded', finished_at = NOW(), message = $2
          WHERE profile_instance_id = $1 AND state = ANY($3::text[])`,
        [locked.profile.instance_id, `Superseded by a new ${request.kind}.`, OPEN_OPERATION_STATES],
      );
      const profile = (await client.query<Profile>(
        `UPDATE profiles SET status = 'DEPLOYING', deployment_phase = ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL},
            engine_config = $2, engine_config_error = NULL, engine_config_revision = engine_config_revision + 1,
            intent_revision = intent_revision + 1, engine_config_state = 'applying',
            last_error = NULL, last_error_at = NULL, updated_at = NOW()
          WHERE name = $1 RETURNING ${PROFILE_COLUMNS}`, [locked.profile.name, request.config],
      )).rows[0]!;
      const operation = toOperation((await client.query<OperationRow>(
        `INSERT INTO engine_config_operations (profile_name, profile_instance_id, engine, kind,
           previous_config, previous_is_template, applied_revision, intent_revision, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applying') RETURNING ${OPERATION_COLUMNS}`,
        [profile.name, profile.instance_id, request.engine, request.kind, previous, previous === null,
          profile.engine_config_revision, profile.intent_revision],
      )).rows[0]!);
      const descriptor = await insertOwnedBuildJob(client, profile, request.version, [request.engine], versionsRoot);
      const hold = (await client.query<{ id: number }>(
        `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
         VALUES ($1, $2, 'operation', $3, $4::text[], $5, $6) RETURNING id`,
        [request.version.id, descriptor.buildId, String(operation.id), [request.engine], profile.instance_id, profile.intent_revision],
      )).rows[0]!.id;
      const recorded = toOperation((await client.query<OperationRow>(
        `UPDATE engine_config_operations SET recovery_descriptor = $2::jsonb, recovery_reference_id = $3, deployment_job_reference_id = $4
         WHERE id = $1 RETURNING ${OPERATION_COLUMNS}`, [operation.id, JSON.stringify(recovery), hold, descriptor.referenceId],
      )).rows[0]!);
      return { profile, operation: recorded, descriptor, previousStatus: locked.profile.status, attempt };
    });
  }

  async beginRevertDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null> {
    const request = structuredClone(input);
    const versionsRoot = this.requireVersionsRoot(request.profile.name);
    if (!['RUNNING', 'ERROR'].includes(request.profile.status)) return null;
    const locator = await this.locateRecovery(request);
    if (!locator) return null;
    let problem = locator.problem;
    if (!problem && locator.descriptor?.kind === 'immutable-build') {
      try {
        const verified = await this.captureRecovery(locator.descriptor.version, versionsRoot);
        if (!isDeepStrictEqual(verified, locator.descriptor)) problem = CHANGED_RECOVERY;
      } catch { problem = CHANGED_RECOVERY; }
    }
    const result = await this.inTransaction<ClaimedRolloutDeploy | { refusal: string } | null>(async client => {
      await lockRolloutPrefix(client, request);
      const versionRows = (await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM stack_versions WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE', [locator.versionIds],
      )).rows;
      const profile = (await client.query<RecoveryProfile>(
        `SELECT ${PROFILE_COLUMNS}, deploy_job_reference_id FROM profiles WHERE name = $1 FOR UPDATE`, [request.profile.name],
      )).rows[0];
      const row = (await client.query<OperationRow>(`SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1 FOR UPDATE`, [request.ownership.operationId])).rows[0];
      if (!profile || !row || !recoveryOwnerMatches(request, profile, row) ||
          profile.deploy_job_reference_id !== locator.profile.deploy_job_reference_id ||
          !isDeepStrictEqual(recoveryOperationIdentity(row), recoveryOperationIdentity(locator.operation))) return null;
      const references = await readRecoveryReferences(client, row, true);
      const descriptor = locator.descriptor;
      problem ??= recoveryReferenceProblem(profile, row, descriptor, references);
      if (versionRows.length !== locator.versionIds.length || references.some(reference => !locator.versionIds.includes(reference.version_id))) problem = CHANGED_RECOVERY;
      if (descriptor?.kind === 'immutable-build') {
        if (versionRows.find(version => version.id === descriptor.version.id)?.name !== descriptor.version.name) problem = CHANGED_RECOVERY;
        if (!problem) {
          try {
            if (versionRemovalProblem(descriptor.version)) problem = CHANGED_RECOVERY;
            else validateCapturedRecovery(descriptor, descriptor.version, versionsRoot);
          } catch { problem = CHANGED_RECOVERY; }
        }
      }
      if (problem || descriptor?.kind !== 'immutable-build') {
        await interruptRecovery(client, request, locator, problem ?? UNVERIFIED_RECOVERY);
        return { refusal: problem ?? UNVERIFIED_RECOVERY };
      }
      const locked = await planLockedRollout(client, request, profile, descriptor.version, `config-revert-${randomUUID()}`);
      if (!locked) return null;
      const attempt = await reserveRolloutDeploy(client, locked);
      const previous = row.previous_is_template ? null : row.previous_config;
      const restored = (await client.query<Profile>(
        `UPDATE profiles SET status = 'DEPLOYING', deployment_phase = ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL},
            engine_config = $2, engine_config_error = $3, engine_config_revision = engine_config_revision + 1,
            engine_config_state = 'reverting', last_error = NULL, last_error_at = NULL, updated_at = NOW()
          WHERE name = $1 RETURNING ${PROFILE_COLUMNS}`, [locked.profile.name, previous, request.message],
      )).rows[0]!;
      const job = await insertOwnedBuildJob(client, restored, descriptor.version, [request.engine], versionsRoot);
      const operation = toOperation((await client.query<OperationRow>(
        `UPDATE engine_config_operations SET state = 'reverting', message = $2, applied_revision = $3, deployment_job_reference_id = $4
          WHERE id = $1 RETURNING ${OPERATION_COLUMNS}`, [row.id, request.message, restored.engine_config_revision, job.referenceId],
      )).rows[0]!);
      return { profile: restored, operation, descriptor: job, previousStatus: locked.profile.status, attempt };
    });
    if (result && 'refusal' in result) throw new ProfileConfigError(request.profile.name, result.refusal);
    return result;
  }

  /** An explicit action advances intent and records a new owner. The interrupted source stays historical. */
  async beginRestorePreviousDeploy(input: PreparedRecoveryDeploy): Promise<ClaimedRolloutDeploy | null> {
    const request = structuredClone(input);
    const versionsRoot = this.requireVersionsRoot(request.profile.name);
    if (!['RUNNING', 'STOPPED', 'ERROR'].includes(request.profile.status)) return null;
    const locator = await this.locateRecovery(request, false);
    if (!locator) return null;
    const descriptor = locator.descriptor;
    if (locator.problem || descriptor?.kind !== 'immutable-build') throw new ProfileConfigError(request.profile.name, locator.problem ?? UNVERIFIED_RECOVERY);
    try {
      if (!isDeepStrictEqual(await this.captureRecovery(descriptor.version, versionsRoot), descriptor)) throw new Error(CHANGED_RECOVERY);
    } catch { throw new ProfileConfigError(request.profile.name, CHANGED_RECOVERY); }
    return this.inTransaction(async client => {
      await lockRolloutPrefix(client, request);
      const versions = (await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM stack_versions WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE', [locator.versionIds],
      )).rows;
      const current = (await client.query<RecoveryProfile>(
        `SELECT ${PROFILE_COLUMNS}, deploy_job_reference_id FROM profiles WHERE name = $1 FOR UPDATE`, [request.profile.name],
      )).rows[0];
      const source = (await client.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1 FOR UPDATE`, [request.ownership.operationId],
      )).rows[0];
      if (!current || !source || !recoveryOwnerMatches(request, current, source, ['interrupted']) ||
          current.deploy_job_reference_id !== locator.profile.deploy_job_reference_id ||
          !isDeepStrictEqual(recoveryOperationIdentity(source), recoveryOperationIdentity(locator.operation))) return null;
      const references = await readRecoveryReferences(client, source, true);
      if (recoveryReferenceProblem(current, source, descriptor, references, false) || versions.length !== locator.versionIds.length ||
          references.some(reference => !locator.versionIds.includes(reference.version_id)) ||
          versions.find(version => version.id === descriptor.version.id)?.name !== descriptor.version.name) {
        throw new ProfileConfigError(request.profile.name, CHANGED_RECOVERY);
      }
      try {
        if (versionRemovalProblem(descriptor.version)) throw new Error(CHANGED_RECOVERY);
        validateCapturedRecovery(descriptor, descriptor.version, versionsRoot);
      } catch { throw new ProfileConfigError(request.profile.name, CHANGED_RECOVERY); }
      const uncertain = await client.query(
        "SELECT execution_id FROM execution_roots WHERE profile_instance_id = $1 AND state = 'launch-uncertain' ORDER BY execution_id FOR UPDATE",
        [current.instance_id],
      );
      if (uncertain.rowCount) throw new ProfileConfigError(current.name, 'An earlier execution may still be launching. Its completion must be resolved before restoring the previous configuration.');
      const locked = await planLockedRollout(client, request, current, descriptor.version, `config-restore-${randomUUID()}`);
      if (!locked) return null;
      const attempt = await reserveRolloutDeploy(client, locked);
      await client.query(
        "UPDATE engine_config_operations SET state = 'superseded', finished_at = NOW(), message = $2 WHERE id = $1",
        [source.id, 'Superseded by an explicit restore of its saved previous configuration.'],
      );
      const previous = source.previous_is_template ? null : source.previous_config;
      const profile = (await client.query<Profile>(
        `UPDATE profiles SET status = 'DEPLOYING', deployment_phase = ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL},
          engine_config = $2, engine_config_revision = engine_config_revision + 1, intent_revision = intent_revision + 1,
          engine_config_state = 'reverting', engine_config_error = NULL, last_error = NULL, last_error_at = NULL, updated_at = NOW()
          WHERE name = $1 RETURNING ${PROFILE_COLUMNS}`, [current.name, previous],
      )).rows[0]!;
      const operation = (await client.query<OperationRow>(
        `INSERT INTO engine_config_operations (profile_name, profile_instance_id, engine, kind, previous_config,
          previous_is_template, applied_revision, intent_revision, state, source_operation_id, message)
          VALUES ($1,$2,$3,'restore-previous',$4,$5,$6,$7,'reverting',$8,$9) RETURNING ${OPERATION_COLUMNS}`,
        [profile.name, profile.instance_id, request.engine, source.previous_config, source.previous_is_template,
          profile.engine_config_revision, profile.intent_revision, source.id, request.message],
      )).rows[0]!;
      const job = await insertOwnedBuildJob(client, profile, descriptor.version, [request.engine], versionsRoot);
      const hold = (await client.query<{ id: number }>(
        `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
          VALUES ($1,$2,'operation',$3,$4::text[],$5,$6) RETURNING id`,
        [descriptor.version.id, descriptor.version.buildId, String(operation.id), [request.engine], profile.instance_id, profile.intent_revision],
      )).rows[0]!.id;
      const recorded = (await client.query<OperationRow>(
        `UPDATE engine_config_operations SET recovery_descriptor = $2::jsonb, recovery_reference_id = $3, deployment_job_reference_id = $4
          WHERE id = $1 RETURNING ${OPERATION_COLUMNS}`, [operation.id, JSON.stringify(descriptor), hold, job.referenceId],
      )).rows[0]!;
      return { profile, operation: toOperation(recorded), descriptor: job, previousStatus: locked.profile.status, attempt };
    });
  }

  private async locateRecovery(request: PreparedRecoveryDeploy, automatic = true): Promise<RecoveryLocator | null> {
    const operation = (await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1`, [request.ownership.operationId],
    )).rows[0];
    const profile = (await this.pool.query<RecoveryProfile>(
      `SELECT ${PROFILE_COLUMNS}, deploy_job_reference_id FROM profiles WHERE name = $1`, [request.profile.name],
    )).rows[0];
    if (!operation || !profile || !recoveryOwnerMatches(request, profile, operation, automatic ? AUTOMATIC_RECOVERY_STATES : ['interrupted'])) return null;
    let descriptor: RolloutRecoveryDescriptor | null = null;
    try { descriptor = parseRolloutRecoveryDescriptor(operation.recovery_descriptor); } catch { /* The owned failure is recorded after the final locks. */ }
    const references = await readRecoveryReferences(this.pool, operation, false);
    const versionIds = [...new Set([profile.stack_version_id, ...references.map(reference => reference.version_id),
      ...(descriptor ? [descriptor.version.id] : [])])].sort((a, b) => a - b);
    return { operation, profile, descriptor, versionIds,
      problem: recoveryReferenceProblem(profile, operation, descriptor, references, automatic) };
  }

  private requireVersionsRoot(profileName: string): string {
    if (!this.versionsRoot) throw new ProfileConfigError(profileName, 'Rollout build ownership is not configured.');
    return this.versionsRoot;
  }

  async begin(input: BeginRollout): Promise<RolloutStarted | null> {
    return this.inTransaction(async (client) => {
      const current = await lockProfile(client, input.profileName);
      if (!current || current.engine_config_revision !== input.expectedRevision) {
        return null;
      }
      await client.query(
        `UPDATE engine_config_operations
            SET state = 'superseded', finished_at = NOW(), message = $2
          WHERE profile_instance_id = $1 AND state = ANY($3::text[])`,
        [current.instance_id, `Superseded by a new ${input.kind}.`, OPEN_OPERATION_STATES],
      );
      const written = await client.query<Profile>(
        `UPDATE profiles
            SET engine_config = $2,
                engine_config_error = NULL,
                engine_config_revision = engine_config_revision + 1,
                intent_revision = intent_revision + 1,
                engine_config_state = 'applying',
                updated_at = NOW()
          WHERE name = $1
          RETURNING ${PROFILE_COLUMNS}`,
        [input.profileName, input.config],
      );
      const profile = written.rows[0]!;
      const inserted = await client.query<OperationRow>(
        `INSERT INTO engine_config_operations (
           profile_name, profile_instance_id, engine, kind,
           previous_config, previous_is_template, applied_revision, intent_revision, state
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applying')
         RETURNING ${OPERATION_COLUMNS}`,
        [
          profile.name,
          profile.instance_id,
          input.engine,
          input.kind,
          input.previousConfig,
          input.previousIsTemplate,
          profile.engine_config_revision,
          profile.intent_revision,
        ],
      );
      return { profile, operation: toOperation(inserted.rows[0]!) };
    });
  }

  async findById(id: number): Promise<EngineConfigOperation | null> {
    const result = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toOperation(result.rows[0]) : null;
  }

  async findOpen(profileInstanceId: string): Promise<EngineConfigOperation | null> {
    const result = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations
        WHERE profile_instance_id = $1 AND state = ANY($2::text[])`,
      [profileInstanceId, OPEN_OPERATION_STATES],
    );
    return result.rows[0] ? toOperation(result.rows[0]) : null;
  }

  async listOpen(): Promise<EngineConfigOperation[]> {
    const result = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations
        WHERE state = ANY($1::text[])
        ORDER BY id ASC`,
      [OPEN_OPERATION_STATES],
    );
    return result.rows.map(toOperation);
  }

  async supersedeOpen(profileInstanceId: string, message: string): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query(
        'SELECT name FROM profiles WHERE instance_id = $1 FOR UPDATE',
        [profileInstanceId],
      );
      const closed = await client.query<{ profile_name: string }>(
        `UPDATE engine_config_operations
            SET state = 'superseded', finished_at = NOW(), message = $2
          WHERE profile_instance_id = $1 AND state = ANY($3::text[])
          RETURNING profile_name`,
        [profileInstanceId, message, OPEN_OPERATION_STATES],
      );
      if (closed.rowCount) {
        await client.query(
          `UPDATE profiles
              SET engine_config_state = 'superseded', engine_config_error = $2, updated_at = NOW()
            WHERE instance_id = $1`,
          [profileInstanceId, message],
        );
      }
    });
  }

  async transition(
    ownership: RolloutOwnership,
    from: readonly EngineConfigOperationState[],
    to: EngineConfigOperationState,
    patch: Partial<
      Pick<
        EngineConfigOperation,
        'message' | 'containerId' | 'containerStartedAt' | 'recreateFinishedAt' | 'watchStartedAt'
      >
    > = {},
    expectedPreparationJobReferenceId?: number,
  ): Promise<EngineConfigOperation | null> {
    return this.inTransaction(async (client) => {
      const owned = await lockOwned(client, ownership, expectedPreparationJobReferenceId);
      if (!owned || !from.includes(owned.operation.state)) return null;
      const updated = await client.query<OperationRow>(
        `UPDATE engine_config_operations
            SET state = $2,
                message = COALESCE($3, message),
                container_id = COALESCE($4, container_id),
                container_started_at = COALESCE($5, container_started_at),
                recreate_finished_at = COALESCE($6, recreate_finished_at),
                watch_started_at = COALESCE($7, watch_started_at),
                finished_at = CASE WHEN $8::boolean THEN NOW() ELSE finished_at END
          WHERE id = $1
          RETURNING ${OPERATION_COLUMNS}`,
        [
          ownership.operationId,
          to,
          patch.message ?? null,
          patch.containerId ?? null,
          patch.containerStartedAt ?? null,
          patch.recreateFinishedAt ?? null,
          patch.watchStartedAt ?? null,
          closes(to),
        ],
      );
      await client.query(
        `UPDATE profiles
            SET engine_config_state = $2,
                engine_config_error = CASE
                  WHEN $3::text IS NOT NULL THEN $3::text
                  WHEN $2 = 'applied' THEN NULL
                  ELSE engine_config_error
                END,
                updated_at = NOW()
          WHERE name = $1`,
        [owned.profile.name, to, patch.message ?? null],
      );
      return toOperation(updated.rows[0]!);
    });
  }

  async beginRevert(ownership: RolloutOwnership, message: string): Promise<RolloutStarted | null> {
    return this.inTransaction(async (client) => {
      const owned = await lockOwned(client, ownership);
      if (!owned || !['watching', 'applying', 'reverting'].includes(owned.operation.state)) {
        return null;
      }
      const previous = owned.operation.previousIsTemplate ? null : owned.operation.previousConfig;
      const written = await client.query<Profile>(
        `UPDATE profiles
            SET engine_config = $2,
                engine_config_error = $3,
                engine_config_revision = engine_config_revision + 1,
                engine_config_state = 'reverting',
                updated_at = NOW()
          WHERE name = $1
          RETURNING ${PROFILE_COLUMNS}`,
        [owned.profile.name, previous, message],
      );
      const profile = written.rows[0]!;
      const updated = await client.query<OperationRow>(
        `UPDATE engine_config_operations
            SET state = 'reverting', message = $2, applied_revision = $3
          WHERE id = $1
          RETURNING ${OPERATION_COLUMNS}`,
        [ownership.operationId, message, profile.engine_config_revision],
      );
      return { profile, operation: toOperation(updated.rows[0]!) };
    });
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

async function lockProfile(client: PoolClient, name: string): Promise<RecoveryProfile | null> {
  const result = await client.query<RecoveryProfile>(
    `SELECT ${PROFILE_COLUMNS}, deploy_job_reference_id FROM profiles WHERE name = $1 FOR UPDATE`,
    [name],
  );
  return result.rows[0] ?? null;
}

/**
 * The operation and its profile, both locked, when the rollout still owns the
 * deployment: the same instance, the config revision the rollout produced and
 * the intent it started under. Null when any of them moved.
 */
async function lockOwned(
  client: PoolClient,
  ownership: RolloutOwnership,
  expectedPreparationJobReferenceId?: number,
): Promise<{ profile: Profile; operation: EngineConfigOperation } | null> {
  const named = await client.query<{ profile_name: string }>(
    'SELECT profile_name FROM engine_config_operations WHERE id = $1',
    [ownership.operationId],
  );
  const profileName = named.rows[0]?.profile_name;
  if (!profileName) return null;
  const profile = await lockProfile(client, profileName);
  if (
    !profile ||
    profile.instance_id !== ownership.profileInstanceId ||
    profile.engine_config_revision !== ownership.appliedRevision ||
    profile.intent_revision !== ownership.intentRevision
  ) {
    return null;
  }
  const locked = await client.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1 FOR UPDATE`,
    [ownership.operationId],
  );
  const operation = locked.rows[0] ? toOperation(locked.rows[0]) : null;
  if (!operation) return null;
  if (expectedPreparationJobReferenceId !== undefined && (
    !Number.isSafeInteger(expectedPreparationJobReferenceId) || expectedPreparationJobReferenceId < 1 ||
    !['DEPLOYING', 'ERROR'].includes(profile.status) ||
    profile.deploy_job_reference_id !== expectedPreparationJobReferenceId ||
    operation.deploymentJobReferenceId !== expectedPreparationJobReferenceId
  )) return null;
  return { profile, operation };
}

function recoveryOwnerMatches(input: PreparedRecoveryDeploy, profile: RecoveryProfile, row: OperationRow, states = AUTOMATIC_RECOVERY_STATES): boolean {
  const owner = input.ownership;
  return isDeepStrictEqual(rolloutProfileIdentity(profile), rolloutProfileIdentity(input.profile)) &&
    row.id === owner.operationId && row.profile_name === profile.name && row.engine === input.engine &&
    row.profile_instance_id === owner.profileInstanceId && row.profile_instance_id === profile.instance_id &&
    row.intent_revision === owner.intentRevision && row.intent_revision === profile.intent_revision &&
    row.applied_revision === owner.appliedRevision && row.applied_revision === profile.engine_config_revision &&
    states.includes(row.state);
}

function recoveryOperationIdentity(row: OperationRow) {
  return { id: row.id, name: row.profile_name, instance: row.profile_instance_id, engine: row.engine, kind: row.kind,
    previous: row.previous_config, template: row.previous_is_template, revision: row.applied_revision,
    intent: row.intent_revision, state: row.state, descriptor: row.recovery_descriptor,
    reference: row.recovery_reference_id, job: row.deployment_job_reference_id, source: row.source_operation_id };
}

async function readRecoveryReferences(database: Pool | PoolClient, row: OperationRow, lock: boolean): Promise<RecoveryReference[]> {
  const ids = [row.recovery_reference_id, row.deployment_job_reference_id].filter((id): id is number => id !== null);
  return (await database.query<RecoveryReference>(
    `SELECT ${RECOVERY_REFERENCE_COLUMNS} FROM build_references
      WHERE id = ANY($1::int[]) OR (holder_kind = 'operation' AND holder_id = $2)
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [ids, String(row.id)],
  )).rows;
}

function recoveryReferenceProblem(
  profile: RecoveryProfile, row: OperationRow, descriptor: RolloutRecoveryDescriptor | null, references: readonly RecoveryReference[], automatic = true,
): string | null {
  if (descriptor?.kind !== 'immutable-build') return UNVERIFIED_RECOVERY;
  if (profile.stack_version_id !== descriptor.version.id || (automatic && (row.deployment_job_reference_id === null ||
      profile.deploy_job_reference_id !== row.deployment_job_reference_id))) return CHANGED_RECOVERY;
  const sameSource = (reference: RecoveryReference | undefined): reference is RecoveryReference => Boolean(reference &&
    reference.version_id === descriptor.version.id && reference.build_id === descriptor.version.buildId &&
    reference.profile_instance_id === row.profile_instance_id && reference.intent_revision === row.intent_revision &&
    isDeepStrictEqual(reference.services, [row.engine]));
  const hold = references.find(reference => reference.id === row.recovery_reference_id);
  const job = references.find(reference => reference.id === row.deployment_job_reference_id);
  if (!sameSource(hold) || hold.holder_kind !== 'operation' || hold.holder_id !== String(row.id) || hold.resolved_at !== null) return CHANGED_RECOVERY;
  if (automatic && (!sameSource(job) || job.holder_kind !== 'job' || job.holder_id !== profile.name)) return CHANGED_RECOVERY;
  return null;
}

/** Refusal changes only the still-owned operation's visible interruption state. Holds and config remain untouched. */
async function interruptRecovery(client: PoolClient, input: PreparedRecoveryDeploy, locator: RecoveryLocator, message: string): Promise<void> {
  const owner = input.ownership;
  const profile = await client.query(
    `UPDATE profiles SET engine_config_state = 'interrupted', engine_config_error = $2, updated_at = NOW()
      WHERE name = $1 AND instance_id = $3 AND intent_revision = $4 AND engine_config_revision = $5
        AND stack_version_id = $6 AND status = $7 AND deploy_job_reference_id IS NOT DISTINCT FROM $8
      RETURNING name`,
    [input.profile.name, message, owner.profileInstanceId, owner.intentRevision, owner.appliedRevision,
      input.profile.stack_version_id, input.profile.status, locator.profile.deploy_job_reference_id],
  );
  if (!profile.rowCount) return;
  const row = locator.operation;
  const operation = await client.query(
    `UPDATE engine_config_operations SET state = 'interrupted', message = $2, finished_at = NOW()
      WHERE id = $1 AND profile_instance_id = $3 AND intent_revision = $4 AND applied_revision = $5
        AND state = $6 AND recovery_reference_id IS NOT DISTINCT FROM $7
        AND deployment_job_reference_id IS NOT DISTINCT FROM $8 AND recovery_descriptor IS NOT DISTINCT FROM $9::jsonb
      RETURNING id`,
    [row.id, message, owner.profileInstanceId, owner.intentRevision, owner.appliedRevision, row.state,
      row.recovery_reference_id, row.deployment_job_reference_id, row.recovery_descriptor === null ? null : JSON.stringify(row.recovery_descriptor)],
  );
  if (!operation.rowCount) throw new ProfileConfigError(input.profile.name, CHANGED_RECOVERY);
}
