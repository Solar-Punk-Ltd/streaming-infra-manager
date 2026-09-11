import { isDeepStrictEqual } from 'node:util';
import { engineForComponents, portExposureProblem, slotCapFor, type EngineName } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';
import type { Profile, ProfileStatus } from '../../types/index.js';
import type { AttemptSnapshotToken, NewDeployAttempt } from '../DeployAttemptRepository.js';
import type { DeployAttempt } from '../deployAttempts.js';
import { captureAttemptSnapshotToken, lockAttemptDaemon, openDeployAttempt } from '../deployAttemptSql.js';
import { DeployAttemptRefusedError, ProfileConfigError, TargetNotVerifiedError } from '../errors/index.js';
import { PROFILE_COLUMNS, PROFILE_SLOT_LOCK_KEY } from '../profileSql.js';
import { targetAlias } from '../ports/DeployTargets.js';
import { portPlanFor, type PortPlanEntry } from '../ports/portReservations.js';
import { planPortReservations } from '../ports/reservationSql.js';
import { deployOwnerOf, type BuildDescriptor } from '../versions/buildLedger.js';
import { lockBuildJobProfile } from '../versions/buildJobClaim.js';
import { portTableForEngine } from '../versions/enginePortTable.js';
import type { DeployVersionSnapshot, StackVersionRecord } from '../versions/StackVersionRepository.js';
import type { RolloutStarted } from './EngineConfigOperationRepository.js';
import type { RolloutOwnership } from './operations.js';

export interface RolloutAdmissionProof {
  alias: string;
  daemonId: string;
  verifiedAt: string;
  inventorySeededAt: string;
  daemonInventorySeededAt: string;
  snapshotToken: AttemptSnapshotToken;
}

export interface PreparedRolloutDeploy {
  profile: Profile;
  version: StackVersionRecord;
  engine: EngineName;
  admission: RolloutAdmissionProof;
  snapshot: { daemonId: string; containerIds: readonly string[] };
}

export interface PreparedRecoveryDeploy extends Omit<PreparedRolloutDeploy, 'version'> {
  ownership: RolloutOwnership;
  message: string;
}

export interface ClaimedRolloutDeploy extends RolloutStarted {
  descriptor: BuildDescriptor;
  previousStatus: ProfileStatus;
  attempt: DeployAttempt;
}

export function rolloutProfileIdentity(profile: Profile) {
  return { name: profile.name, ...deployOwnerOf(profile), status: profile.status, host: profile.host,
    portSlot: profile.port_slot, components: profile.components, kind: profile.kind };
}

const STAMP_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

async function readTargetProof(client: PoolClient, alias: string, daemonId: string): Promise<Omit<RolloutAdmissionProof, 'snapshotToken'>> {
  const target = (await client.query<{ daemon_id: string | null; verified_at: string | null; last_error: string | null }>(
    `SELECT daemon_id, to_char(verified_at AT TIME ZONE 'UTC', '${STAMP_FORMAT}') AS verified_at, last_error
       FROM deploy_targets WHERE alias = $1 FOR SHARE`, [alias],
  )).rows[0];
  const inventory = (await client.query<{ seeded_at: string | null }>(
    `SELECT to_char(seeded_at AT TIME ZONE 'UTC', '${STAMP_FORMAT}') AS seeded_at
       FROM reservation_inventory WHERE id = 1 FOR SHARE`,
  )).rows[0];
  const daemon = (await client.query<{ seeded_at: string }>(
    `SELECT to_char(seeded_at AT TIME ZONE 'UTC', '${STAMP_FORMAT}') AS seeded_at
       FROM reservation_daemon_inventory WHERE daemon_id = $1 FOR SHARE`, [daemonId],
  )).rows[0];
  if (!target || target.daemon_id !== daemonId || !target.verified_at || target.last_error !== null ||
      !inventory?.seeded_at || !daemon?.seeded_at) {
    throw new TargetNotVerifiedError(alias, 'The deployment target or its port inventory is not verified.');
  }
  return { alias, daemonId, verifiedAt: target.verified_at, inventorySeededAt: inventory.seeded_at,
    daemonInventorySeededAt: daemon.seeded_at };
}

/** Read before Docker. The final transaction rechecks every value while holding the same locks. */
export async function captureRolloutAdmission(client: PoolClient, expected: Profile): Promise<RolloutAdmissionProof> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
  const alias = targetAlias(expected.host);
  const locator = (await client.query<{ daemon_id: string | null }>('SELECT daemon_id FROM deploy_targets WHERE alias = $1', [alias])).rows[0];
  if (!locator?.daemon_id) throw new TargetNotVerifiedError(alias);
  await lockAttemptDaemon(client, locator.daemon_id);
  if (!(await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR SHARE', [expected.stack_version_id])).rowCount) {
    throw new ProfileConfigError(expected.name, 'The selected stack version no longer exists.');
  }
  const profile = (await client.query<Profile>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE name = $1 FOR UPDATE`, [expected.name])).rows[0];
  if (!profile || !isDeepStrictEqual(rolloutProfileIdentity(profile), rolloutProfileIdentity(expected))) {
    throw new ProfileConfigError(expected.name, 'The deployment changed before its target could be captured.');
  }
  const proof = await readTargetProof(client, alias, locator.daemon_id);
  return { ...proof, snapshotToken: await captureAttemptSnapshotToken(client, locator.daemon_id, profile.name) };
}

export interface LockedRolloutDeploy {
  profile: Profile;
  ports: readonly PortPlanEntry[];
  attempt: NewDeployAttempt;
}

/** Every admission takes these global locks before version or profile rows. */
export async function lockRolloutPrefix(client: PoolClient, input: Omit<PreparedRolloutDeploy, 'version'>): Promise<void> {
  const { profile: expected, admission, snapshot } = input;
  if (!admission?.snapshotToken) throw new DeployAttemptRefusedError(expected.name, 'A captured container snapshot token is required.');
  if (snapshot.daemonId !== admission.daemonId) throw new TargetNotVerifiedError(admission.alias, 'The container snapshot came from another daemon.');
  await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
  await lockAttemptDaemon(client, admission.daemonId);
}

/** Locks allocation, daemon, version, profile and target evidence before any final writes. */
export async function lockRolloutDeploy(client: PoolClient, input: PreparedRolloutDeploy, jobId: string): Promise<LockedRolloutDeploy | null> {
  const { profile: expected, version, engine } = input;
  await lockRolloutPrefix(client, input);
  const profile = await lockBuildJobProfile(client, { profileName: expected.name, version,
    ownership: deployOwnerOf(expected), services: [engine], transition: { from: [expected.status], intent: 'preserve' } });
  return planLockedRollout(client, input, profile, version, jobId);
}

/** The caller has already locked its artifact authority and profile. No ownership or payload is written here. */
export async function planLockedRollout(
  client: PoolClient, input: Omit<PreparedRolloutDeploy, 'version'>, profile: Profile | null,
  version: DeployVersionSnapshot, jobId: string,
): Promise<LockedRolloutDeploy | null> {
  const { profile: expected, engine, admission, snapshot } = input;
  if (!profile || !['RUNNING', 'STOPPED', 'ERROR'].includes(profile.status) ||
      !isDeepStrictEqual(rolloutProfileIdentity(profile), rolloutProfileIdentity(expected))) return null;
  if (targetAlias(profile.host) !== admission.alias) return null;
  const current = { ...await readTargetProof(client, admission.alias, admission.daemonId),
    snapshotToken: await captureAttemptSnapshotToken(client, admission.daemonId, profile.name) };
  if (!isDeepStrictEqual(current, admission)) {
    if (!isDeepStrictEqual(current.snapshotToken, admission.snapshotToken)) {
      throw new DeployAttemptRefusedError(profile.name, 'Deploy attempt history changed while the container snapshot was read.');
    }
    throw new TargetNotVerifiedError(admission.alias, 'The target verification or inventory generation changed during preparation.');
  }
  const contract = version.contract;
  if (!contract?.ports.length || contract.allocationProblem || !contract.engineConfig[engine] || engineForComponents(profile.components) !== engine) {
    throw new ProfileConfigError(profile.name, 'The captured version cannot deploy this engine configuration.');
  }
  if (profile.port_slot < 1 || profile.port_slot > slotCapFor(contract)) throw new ProfileConfigError(profile.name, 'The captured deployment slot is outside its supported range.');
  const ports = portPlanFor(portTableForEngine(contract, engine), profile.port_slot);
  const problem = ports.map(portExposureProblem).find(value => value !== null);
  if (problem) throw new ProfileConfigError(profile.name, problem);
  return { profile, ports, attempt: { daemonId: admission.daemonId, target: admission.alias,
    project: profile.name, jobId, kind: contract.features.sharedImageTags ? 'shared' : 'fixed', services: [engine],
    preJobContainerIds: snapshot.containerIds, snapshotToken: admission.snapshotToken } };
}

/** The owner and operation preconditions have passed while their locks remain held. */
export async function reserveRolloutDeploy(client: PoolClient, locked: LockedRolloutDeploy): Promise<DeployAttempt> {
  await planPortReservations(client, locked.attempt.daemonId, locked.profile.name, locked.ports, `config rollout ${locked.attempt.jobId}`);
  return openDeployAttempt(client, locked.attempt);
}
