import { isDeepStrictEqual } from 'node:util';
import { parseStackContract } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';

import type { Profile, ProfileStatus } from '../../types/index.js';
import { ProfileConfigError } from '../errors/index.js';
import { OPEN_OPERATION_STATES } from '../engineConfig/operations.js';
import { DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL, PROFILE_COLUMNS } from '../profileSql.js';
import type { BuildDescriptor, ClaimedDeploy, DeployClaimOwnership, ExpectedDeployOwner } from './buildLedger.js';
import { readBuildManifest } from './buildManifest.js';
import { buildIdOfRoot } from './buildReferences.js';
import { deployRootProblem, stackRootOf } from './stackPaths.js';
import type { DeployVersionSnapshot, StackVersionRecord } from './StackVersionRepository.js';

interface DeploySnapshotRow {
  id: number;
  name: string;
  root_path: string | null;
  layout: StackVersionRecord['layout'];
  build_id: string | null;
  commit_sha: string | null;
  contract: unknown;
}

interface BuildJobRequest {
  profileName: string;
  version: StackVersionRecord | null;
  services: readonly string[];
  ownership: ExpectedDeployOwner;
  transition: { from: readonly ProfileStatus[]; intent: DeployClaimOwnership['intent']; supersedeReason?: string } | null;
}

function sameOwner(profile: Profile, expected: ExpectedDeployOwner): boolean {
  return profile.instance_id === expected.instanceId && profile.intent_revision === expected.intentRevision &&
    profile.engine_config_revision === expected.configRevision && profile.stack_version_id === expected.stackVersionId;
}

/** A publication may finish while the caller waits. Validate the selected artifact under the shared version lock. */
async function lockDeploySnapshot(client: PoolClient, profileName: string, version: StackVersionRecord): Promise<void> {
  const result = await client.query<DeploySnapshotRow>(
    `SELECT id, name, root_path, layout, build_id, commit_sha, contract
       FROM stack_versions WHERE id = $1 FOR SHARE`, [version.id],
  );
  const row = result.rows[0];
  if (!row) throw new ProfileConfigError(profileName, `Stack version ${version.name} (${version.id}) no longer exists. No deployment was started.`);
  const captured = { id: version.id, name: version.name, rootPath: version.rootPath, layout: version.layout,
    buildId: version.buildId, commitSha: version.commitSha, contract: version.contract };
  const locked = { id: row.id, name: row.name, rootPath: row.root_path, layout: row.layout,
    buildId: row.build_id, commitSha: row.commit_sha, contract: parseStackContract(row.contract) };
  if (!isDeepStrictEqual(captured, locked)) {
    throw new ProfileConfigError(profileName, `Stack version ${version.name} changed after build ${version.buildId ?? version.commitSha ?? 'unknown'} was selected. Review the current version before deploying.`);
  }
  const problem = deployRootProblem(version);
  if (problem) throw new ProfileConfigError(profileName, problem);
  if (version.layout === 'builds') {
    const { manifest } = readBuildManifest(stackRootOf(version));
    if (manifest?.buildId !== version.buildId || manifest?.commit !== version.commitSha) {
      throw new ProfileConfigError(profileName, `Build ${version.buildId} of ${version.name} has a manifest that does not match its selected identity. No deployment was started.`);
    }
  }
}

/** Validate the captured version and profile while retaining their locks in the caller's transaction. */
export async function lockBuildJobProfile(client: PoolClient, input: BuildJobRequest): Promise<Profile | null> {
  const request = structuredClone(input);
  const { profileName, version, ownership, transition } = request;
  if (!version) throw new ProfileConfigError(profileName, 'The selected stack version no longer exists. No deployment was started.');
  await lockDeploySnapshot(client, profileName, version);
  const selected = await client.query<Profile & { deploy_job_reference_id: number | null }>(
    `SELECT ${PROFILE_COLUMNS}, deploy_job_reference_id FROM profiles WHERE name = $1 FOR UPDATE`, [profileName],
  );
  const profile = selected.rows[0];
  if (!profile || !sameOwner(profile, ownership) || version.id !== ownership.stackVersionId ||
      (transition ? !transition.from.includes(profile.status) : profile.status !== 'DEPLOYING' || selected.rows[0]!.deploy_job_reference_id !== null)) return null;
  return profile;
}

/** The caller owns the transaction. Version, profile and reference ownership commit or roll back together. */
export async function claimBuildJob(client: PoolClient, input: BuildJobRequest, versionsRoot: string): Promise<ClaimedDeploy | null> {
  const request = structuredClone(input);
  const { profileName, version, ownership, transition } = request;
  let profile = await lockBuildJobProfile(client, request);
  if (!profile || !version) return null;
  const previousStatus = profile.status;
  if (transition) {
    const updated = await client.query<Profile>(
      `UPDATE profiles SET status = 'DEPLOYING',
         deployment_phase = ${DEPLOYMENT_PHASE_FROM_PRIOR_STATUS_SQL},
         intent_revision = intent_revision + $2,
         last_error = NULL, last_error_at = NULL, updated_at = NOW()
       WHERE name = $1 AND instance_id = $3 AND intent_revision = $4
         AND engine_config_revision = $5 AND stack_version_id = $6 AND status = ANY($7::text[])
       RETURNING ${PROFILE_COLUMNS}`,
      [profileName, transition.intent === 'advance' ? 1 : 0, ownership.instanceId, ownership.intentRevision,
        ownership.configRevision, ownership.stackVersionId, transition.from],
    );
    profile = updated.rows[0] ?? null;
    if (!profile) return null;
    if (transition.intent === 'advance') {
      const reason = transition.supersedeReason ?? 'Superseded by a new deployment action.';
      const superseded = await client.query(
        `UPDATE engine_config_operations SET state = 'superseded', finished_at = NOW(), message = $2
         WHERE profile_instance_id = $1 AND state = ANY($3::text[])`,
        [profile.instance_id, reason, OPEN_OPERATION_STATES],
      );
      if (superseded.rowCount) {
        profile = (await client.query<Profile>(
          `UPDATE profiles SET engine_config_state = 'superseded', engine_config_error = $2
           WHERE name = $1 RETURNING ${PROFILE_COLUMNS}`, [profileName, reason],
        )).rows[0]!;
      }
    }
  }
  const descriptor = await insertOwnedBuildJob(client, profile, version, request.services, versionsRoot);
  return { profile, previousStatus, descriptor };
}

/** The version and profile are already locked. Record only the final profile identity produced by this transaction. */
export async function insertOwnedBuildJob(
  client: PoolClient, profile: Profile, version: DeployVersionSnapshot, services: readonly string[], versionsRoot: string,
): Promise<BuildDescriptor> {
  const root = stackRootOf(version);
  const buildId = buildIdOfRoot(versionsRoot, root);
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
     VALUES ($1, $2, 'job', $3, $4::text[], $5, $6) RETURNING id`,
    [version.id, buildId, profile.name, [...services], profile.instance_id, profile.intent_revision],
  );
  const referenceId = inserted.rows[0]!.id;
  await client.query('UPDATE profiles SET deploy_job_reference_id = $2 WHERE name = $1', [profile.name, referenceId]);
  return { version, buildId, root, referenceId };
}

/** The active reference makes even same-intent recovery claims distinct. Clearing it never retires another hold. */
export async function cancelBuildJob(
  client: PoolClient,
  owner: Pick<Profile, 'name' | 'instance_id' | 'intent_revision'>,
  referenceId: number,
  previousStatus: ProfileStatus,
): Promise<Profile | null> {
  const source = (await client.query<{ version_id: number }>('SELECT version_id FROM build_references WHERE id = $1', [referenceId])).rows[0];
  if (!source) return null;
  if (!(await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR SHARE', [source.version_id])).rowCount) return null;
  const profile = (await client.query<Profile>(
    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = $1 AND instance_id = $2 AND intent_revision = $3
     AND status = 'DEPLOYING' AND deploy_job_reference_id = $4 FOR UPDATE`,
    [owner.name, owner.instance_id, owner.intent_revision, referenceId],
  )).rows[0];
  if (!profile) return null;
  const job = await client.query(
    `SELECT id FROM build_references WHERE id = $1 AND holder_kind = 'job' AND holder_id = $2
     AND profile_instance_id = $3 AND intent_revision = $4 AND resolved_at IS NULL FOR UPDATE`,
    [referenceId, owner.name, owner.instance_id, owner.intent_revision],
  );
  if (!job.rowCount) return null;
  const execution = await client.query<{ state: string }>('SELECT state FROM execution_roots WHERE job_reference_id = $1 FOR UPDATE', [referenceId]);
  if (execution.rows.some(row => row.state === 'launch-uncertain')) return null;
  await client.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [referenceId]);
  return (await client.query<Profile>(
    `UPDATE profiles SET status = $2, deployment_phase = NULL, last_error = NULL, last_error_at = NULL,
       deploy_job_reference_id = NULL, updated_at = NOW()
     WHERE name = $1 AND instance_id = $3 AND intent_revision = $4 AND status = 'DEPLOYING' AND deploy_job_reference_id = $5
     RETURNING ${PROFILE_COLUMNS}`,
    [owner.name, previousStatus, owner.instance_id, owner.intent_revision, referenceId],
  )).rows[0] ?? null;
}
