import type { EngineName } from '@streaming-infra-manager/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

import { Profile } from '../../types/index.js';
import { DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL, PROFILE_COLUMNS } from '../profileSql.js';
import { ProfileConfigError } from '../errors/index.js';
import { insertOwnedBuildJob } from '../versions/buildJobClaim.js';
import { captureRolloutAdmission, lockRolloutDeploy, reserveRolloutDeploy,
  type ClaimedRolloutDeploy, type PreparedRolloutDeploy, type RolloutAdmissionProof } from './rolloutDeployAdmission.js';
import { captureRolloutRecovery, parseRolloutRecoveryDescriptor, validateCapturedRecovery,
  type RolloutRecoveryCapture } from './rolloutRecoveryDescriptor.js';

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
  recovery_descriptor, recovery_reference_id, deployment_job_reference_id
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
}

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

  async beginDeploy(input: PreparedRolloutDeploy & { kind: EngineConfigOperationKind; config: string | null }): Promise<ClaimedRolloutDeploy | null> {
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

  async beginRevertDeploy(input: PreparedRolloutDeploy & { ownership: RolloutOwnership; message: string }): Promise<ClaimedRolloutDeploy | null> {
    const request = structuredClone(input);
    const versionsRoot = this.requireVersionsRoot(request.profile.name);
    if (!['RUNNING', 'ERROR'].includes(request.profile.status)) return null;
    return this.inTransaction(async client => {
      const locked = await lockRolloutDeploy(client, request, `config-revert-${randomUUID()}`);
      if (!locked) return null;
      const row = (await client.query<OperationRow>(`SELECT ${OPERATION_COLUMNS} FROM engine_config_operations WHERE id = $1 FOR UPDATE`, [request.ownership.operationId])).rows[0];
      const owner = request.ownership;
      if (!row || row.profile_name !== locked.profile.name || row.profile_instance_id !== locked.profile.instance_id ||
          row.profile_instance_id !== owner.profileInstanceId || row.intent_revision !== locked.profile.intent_revision ||
          row.intent_revision !== owner.intentRevision || row.applied_revision !== locked.profile.engine_config_revision ||
          row.applied_revision !== owner.appliedRevision || row.engine !== request.engine ||
          !['watching', 'applying', 'reverting'].includes(row.state)) return null;
      const attempt = await reserveRolloutDeploy(client, locked);
      const previous = row.previous_is_template ? null : row.previous_config;
      const profile = (await client.query<Profile>(
        `UPDATE profiles SET status = 'DEPLOYING', deployment_phase = ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL},
            engine_config = $2, engine_config_error = $3, engine_config_revision = engine_config_revision + 1,
            engine_config_state = 'reverting', last_error = NULL, last_error_at = NULL, updated_at = NOW()
          WHERE name = $1 RETURNING ${PROFILE_COLUMNS}`, [locked.profile.name, previous, request.message],
      )).rows[0]!;
      const operation = toOperation((await client.query<OperationRow>(
        `UPDATE engine_config_operations SET state = 'reverting', message = $2, applied_revision = $3
          WHERE id = $1 RETURNING ${OPERATION_COLUMNS}`, [row.id, request.message, profile.engine_config_revision],
      )).rows[0]!);
      const descriptor = await insertOwnedBuildJob(client, profile, request.version, [request.engine], versionsRoot);
      return { profile, operation, descriptor, previousStatus: locked.profile.status, attempt };
    });
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
  ): Promise<EngineConfigOperation | null> {
    return this.inTransaction(async (client) => {
      const owned = await lockOwned(client, ownership);
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

async function lockProfile(client: PoolClient, name: string): Promise<Profile | null> {
  const result = await client.query<Profile>(
    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = $1 FOR UPDATE`,
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
  return locked.rows[0] ? { profile, operation: toOperation(locked.rows[0]) } : null;
}
