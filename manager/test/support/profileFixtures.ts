import {
  ADMIN_API_TOKEN_KEY,
  configuredBeeRpcEndpoint,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  type EngineSettings,
  isPendingStamp,
  isSecretSettingKey,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

import { ContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { ManagerAdminTokenElsewhereError, ManagerAdminTokenMissingError } from '../../src/domain/errors/index.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';
import type { StackSecrets } from '../../src/domain/versions/stackSecrets.js';
import type { ExpectedDeployOwner } from '../../src/domain/versions/buildLedger.js';
import { ContainerRepository, type ContainerRow } from '../../src/domain/ContainerRepository.js';
import {
  EngineOverviewSnapshot,
  EngineSettingsWriteOwner,
  type InitialStackSettings,
  NewProfilePlacement,
  NO_STACK_SETTINGS,
  ProfileRepository,
  type ProfileRemovalClaim,
  ProfileWriteData,
  type StackSettingsChange,
  type StoredStackSettings,
} from '../../src/domain/ProfileRepository.js';
import {
  ApiContainer,
  Profile,
  ProfileKind,
  ProfileStatus,
  ProfileWithContainers,
  TRANSITIONAL_STATUSES,
} from '../../src/types/index.js';

import { InMemoryManagerAdminLink } from './InMemoryManagerAdminLink.js';
import { InMemoryPortReservations } from './InMemoryPortReservations.js';

export type ProfileFixture = Profile & { rpc_endpoint?: string | null };

export function makeProfile(over: Partial<ProfileFixture> = {}): ProfileFixture {
  const profile: ProfileFixture = {
    name: 'stage',
    port_slot: 1,
    kind: 'streamer',
    notes: null,
    notes_revision: 0,
    components: null,
    instance_id: 'instance-1',
    engine_config_revision: 0,
    intent_revision: 0,
    engine_config_state: null,
    host: null,
    feed_owner: null,
    feed_topic: null,
    has_private_key: false,
    public_key: null,
    stamp_id: null,
    bee_publishers: null,
    bee_url: null,
    rpc_endpoint: null,
    has_rpc_endpoint: false,
    rpc_endpoint_host: null,
    rpc_endpoint_source: DEFAULT_RPC_ENDPOINT_SOURCE,
    node_mode: null,
    has_srt_passphrase: false,
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    stack_version_id: 1,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    last_full_deploy_commit: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    group_id: null,
    ...over,
  };
  if (profile.rpc_endpoint) {
    profile.has_rpc_endpoint = true;
    profile.rpc_endpoint_host = configuredBeeRpcEndpoint(profile.rpc_endpoint).host;
  }
  return profile;
}

function definedFields(data: ProfileWriteData): Partial<Profile> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch as Partial<Profile>;
}

/**
 * The slice of ProfileRepository the deploy paths use, over a Map.
 *
 * `transitionStatus` keeps the compare-and-set the real UPDATE performs. That
 * is the point of the fake: the compare-and-set is what decides which caller
 * owns a deployment, so a test of ownership has to run against a real one.
 */
export class InMemoryProfiles {
  readonly rows = new Map<string, Profile>();

  readonly markErrorCalls: string[] = [];

  readonly activeDeployJobs = new Map<string, number>();

  readonly updateEditableCalls: string[] = [];

  /** Names whose claim is refused, as though another caller took it first. */
  readonly claimsRefused = new Set<string>();

  /** Names whose `updateEditable` throws, standing in for a rejected write. */
  readonly writesRefused = new Set<string>();

  /** The `stack_secrets` column, kept apart from the rows the way the real one is read. */
  readonly secrets = new Map<string, StackSecrets>();

  /** The `engine_config` column, kept apart from the rows for the same reason. */
  readonly engineConfigs = new Map<string, string>();

  /** The `private_key` column, kept apart from the rows for the same reason. */
  readonly privateKeys = new Map<string, string>();

  /** The `srt_passphrase` column, kept apart from the rows for the same reason. */
  readonly passphrases = new Map<string, string>();

  /** The custom RPC URL, kept apart from the rows returned to pages and events. */
  readonly rpcEndpoints = new Map<string, string>();

  /** The `stack_settings` and `stack_settings_secret` columns together, as the deploy reads them. */
  readonly stackSettings = new Map<string, Record<string, string>>();

  /** Each deployment's `admin_token_origin`, left out where it is null. */
  readonly adminTokenOrigins = new Map<string, string | null>();

  /** Each deployment's `settings_revision`, 0 until its first save. */
  readonly settingsRevisions = new Map<string, number>();

  /** The manager's own web2 admin link, whose token an insert that asks for it copies. */
  readonly managerAdminLink = new InMemoryManagerAdminLink();

  onDeleted?: (name: string) => void;

  constructor(
    profiles: readonly ProfileFixture[] = [],
    /** The reservation table the allocator writes, when a test gave it one. */
    readonly reservations: InMemoryPortReservations = new InMemoryPortReservations(),
  ) {
    for (const profile of profiles) this.storeFixture(profile);
  }

  private storeFixture(profile: ProfileFixture): Profile {
    const { rpc_endpoint: endpoint, ...publicProfile } = profile;
    const metadata = configuredBeeRpcEndpoint(endpoint);
    if (endpoint) this.rpcEndpoints.set(profile.name, endpoint);
    const row: Profile = {
      ...publicProfile,
      has_rpc_endpoint: metadata.configured,
      rpc_endpoint_host: metadata.host,
    };
    this.rows.set(profile.name, row);
    return row;
  }

  /** The slots every stored record holds, stopped ones included. */
  takenSlots(): Set<number> {
    return new Set([...this.rows.values()].map((row) => row.port_slot));
  }

  asRepository(): ProfileRepository {
    return this as unknown as ProfileRepository;
  }

  statusOf(name: string): ProfileStatus | undefined {
    return this.rows.get(name)?.status;
  }

  async findByName(name: string): Promise<Profile | null> {
    return this.rows.get(name) ?? null;
  }

  async engineOverviewSnapshot(name: string): Promise<EngineOverviewSnapshot | null> {
    const profile = this.rows.get(name);
    if (!profile) return null;
    return { profile: structuredClone(profile), engineConfig: this.engineConfigs.get(name) ?? null };
  }

  async list(): Promise<Profile[]> {
    return [...this.rows.values()];
  }

  /**
   * The lowest slot no record holds and no port of which anyone holds on the
   * daemon, with every port of it reserved planned in one step, as the SQL
   * does it in one transaction.
   */
  async insertWithFreeSlot(
    name: string,
    kind: ProfileKind,
    status: ProfileStatus,
    data: ProfileWriteData,
    placement: NewProfilePlacement,
    engineSettings: EngineSettings = {},
    stackSettings: InitialStackSettings = NO_STACK_SETTINGS,
  ): Promise<Profile | null> {
    if (this.rows.has(name)) throw new Error(`duplicate profile name: ${name}`);
    const slot = this.reservations.freeSlot(placement.daemonId, placement.table, placement.slotCap, this.takenSlots());
    if (slot === null) return null;
    // Asked before anything is stored, because the real insert's transaction rolls back whole.
    this.initialValuesOf(stackSettings);
    const {
      private_key: key,
      srt_passphrase: passphrase,
      rpc_endpoint: rpcEndpoint,
      ...rest
    } = data;
    if (key) this.privateKeys.set(name, key);
    if (passphrase) this.passphrases.set(name, passphrase);
    if (rpcEndpoint) this.rpcEndpoints.set(name, rpcEndpoint);
    const endpointMetadata = configuredBeeRpcEndpoint(rpcEndpoint);
    const fixture = makeProfile({
      name,
      kind,
      status,
      ...definedFields(rest),
      rpc_endpoint: rpcEndpoint,
      // COALESCE($18, 'stack') in the real INSERT: a create that names no
      // source stores the stack's endpoint rather than a null the column
      // refuses.
      rpc_endpoint_source: rest.rpc_endpoint_source ?? DEFAULT_RPC_ENDPOINT_SOURCE,
      has_rpc_endpoint: endpointMetadata.configured,
      rpc_endpoint_host: endpointMetadata.host,
      has_private_key: Boolean(key),
      has_srt_passphrase: Boolean(passphrase),
      engine_settings: { ...engineSettings },
      port_slot: slot,
      stack_version_id: placement.stackVersionId,
    });
    const row = this.storeFixture(fixture);
    this.storeInitialStackSettings(name, stackSettings);
    this.reservations.planNow(placement.daemonId, name, portPlanFor(placement.table, slot), `allocated with ${name}`);
    return row;
  }

  /**
   * What a create stores in both columns, with the manager's token copied in
   * when it asks, as the insert's own SQL copies it. Refuses as that does when
   * none is stored or when it was saved for another origin.
   */
  initialValuesOf(stackSettings: InitialStackSettings): Record<string, string> {
    const values = { ...stackSettings.plain, ...stackSettings.secret };
    if (!stackSettings.copyManagerAdminToken) return values;
    if (this.managerAdminLink.token === null) throw new ManagerAdminTokenMissingError();
    if (!sameAdminOrigin(stackSettings.copyManagerAdminToken.url, this.managerAdminLink.url ?? '')) throw new ManagerAdminTokenElsewhereError();
    return { ...values, [ADMIN_API_TOKEN_KEY]: this.managerAdminLink.token };
  }

  /** Both columns as one set, the way `stackSettings` keeps them, and nothing for a create that named none. */
  storeInitialStackSettings(name: string, stackSettings: InitialStackSettings): void {
    const values = this.initialValuesOf(stackSettings);
    if (Object.keys(values).length > 0) this.stackSettings.set(name, values);
    if (stackSettings.adminTokenOrigin !== undefined) this.adminTokenOrigins.set(name, stackSettings.adminTokenOrigin);
  }

  async transitionStatus(
    name: string,
    next: ProfileStatus,
    allowedFrom: readonly ProfileStatus[],
    expectedInstanceId?: string,
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || this.claimsRefused.has(name)) return null;
    if (expectedInstanceId !== undefined && row.instance_id !== expectedInstanceId) return null;
    if (!allowedFrom.includes(row.status)) return null;
    return this.write(name, {
      status: next,
      last_error: null,
      last_error_at: null,
    });
  }

  async markTerminal(
    name: string,
    status: ProfileStatus,
    expectedInstanceId?: string,
  ): Promise<Profile | null> {
    if (expectedInstanceId !== undefined && this.rows.get(name)?.instance_id !== expectedInstanceId) return null;
    return this.write(name, {
      status,
      last_error: null,
      last_error_at: null,
    });
  }

  async deleteByName(name: string): Promise<{ port_slot: number } | null> {
    const row = this.rows.get(name);
    if (!row) return null;
    if (row.status !== 'REMOVING') throw new Error('The deployment has not completed removal');
    this.rows.delete(name);
    this.privateKeys.delete(name);
    this.passphrases.delete(name);
    this.rpcEndpoints.delete(name);
    this.reservations.dropProfile(name);
    this.onDeleted?.(name);
    return { port_slot: row.port_slot };
  }

  async claimRemoval(name: string, expectedInstanceId: string): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || row.instance_id !== expectedInstanceId || this.claimsRefused.has(name)
      || !['RUNNING', 'STOPPED', 'ERROR'].includes(row.status)) return null;
    return this.write(name, { status: 'REMOVING', intent_revision: row.intent_revision + 1, last_error: null, last_error_at: null });
  }

  private ownsRemoval(claim: ProfileRemovalClaim): boolean {
    const row = this.rows.get(claim.name);
    return !!row && row.instance_id === claim.instance_id && row.intent_revision === claim.intent_revision && row.status === 'REMOVING';
  }

  async failRemoval(claim: ProfileRemovalClaim, message: string): Promise<Profile | null> {
    if (!this.ownsRemoval(claim)) return null;
    return this.markError(claim.name, message);
  }

  async completeRemoval(claim: ProfileRemovalClaim, cleanFiles: () => Promise<void>): Promise<{ port_slot: number } | null> {
    if (!this.ownsRemoval(claim)) return null;
    if (await this.reservations.hasRemovalHold(claim.name)) throw new Error('An unresolved removal hold remains');
    await cleanFiles();
    return this.deleteByName(claim.name);
  }

  async orphanedTransitions(): Promise<Profile[]> {
    return [...this.rows.values()].filter((row) => TRANSITIONAL_STATUSES.includes(row.status));
  }

  async settleOrphanedTransition(
    name: string,
    status: ProfileStatus,
    message: string | null,
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || !TRANSITIONAL_STATUSES.includes(row.status)) return null;
    return this.write(name, {
      status,
      deployment_phase: null,
      last_error: message,
      last_error_at: message === null ? null : new Date(),
    });
  }

  async markError(name: string, message: string): Promise<Profile | null> {
    this.markErrorCalls.push(name);
    return this.write(name, {
      status: 'ERROR',
      deployment_phase: null,
      last_error: message,
      last_error_at: new Date(),
    });
  }

  async markDeployError(
    name: string,
    owner: ExpectedDeployOwner,
    referenceId: number | null,
    message: string,
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || row.status !== 'DEPLOYING' || row.instance_id !== owner.instanceId ||
        row.intent_revision !== owner.intentRevision || row.engine_config_revision !== owner.configRevision ||
        row.stack_version_id !== owner.stackVersionId || (this.activeDeployJobs.get(name) ?? null) !== referenceId) return null;
    return this.markError(name, message);
  }

  async markDeployingError(
    name: string,
    instanceId: string,
    jobReferenceId: number | null,
    message: string,
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (row?.status !== 'DEPLOYING' || row.instance_id !== instanceId) return null;
    if ((this.activeDeployJobs.get(name) ?? null) !== jobReferenceId) return null;
    return this.markError(name, message);
  }

  async updateEditable(
    name: string,
    kind: ProfileKind,
    data: ProfileWriteData = {},
    keptEngineSettingKeys?: readonly string[],
    expectedNotesRevision?: number,
  ): Promise<Profile | null> {
    if (this.writesRefused.has(name)) {
      throw new Error(`write refused for ${name}`);
    }
    this.updateEditableCalls.push(name);
    const row = this.rows.get(name);
    if (!row) return null;
    if (expectedNotesRevision !== undefined && row.notes_revision !== expectedNotesRevision) {
      return null;
    }
    // A secret the write leaves out keeps the stored one, the way the real
    // statement does: COALESCE for the key, and for the passphrase a write
    // that happens only while the body named it, so an explicit null clears.
    const {
      private_key: key,
      srt_passphrase: passphrase,
      node_mode: mode,
      rpc_endpoint: rpcEndpoint,
      ...rest
    } = data;
    if (key) this.privateKeys.set(name, key);
    if (passphrase === null) this.passphrases.delete(name);
    else if (passphrase !== undefined) this.passphrases.set(name, passphrase);
    if (rpcEndpoint === null) this.rpcEndpoints.delete(name);
    else if (rpcEndpoint !== undefined) this.rpcEndpoints.set(name, rpcEndpoint);
    const endpointMetadata = configuredBeeRpcEndpoint(this.rpcEndpoints.get(name));
    const fields = definedFields(rest);
    const notesChanged = 'notes' in fields && fields.notes !== row.notes;
    return this.write(name, {
      kind,
      ...fields,
      // The two the real UPDATE wraps in COALESCE: a caller that names neither
      // keeps what is stored, because the node's mode is chosen when the
      // deployment is created and what an emptied address means is the
      // service's to work out, not the statement's.
      rpc_endpoint_source: rest.rpc_endpoint_source ?? row.rpc_endpoint_source,
      has_rpc_endpoint: endpointMetadata.configured,
      rpc_endpoint_host: endpointMetadata.host,
      ...(mode == null ? {} : { node_mode: mode }),
      ...(key ? { has_private_key: true } : {}),
      ...(passphrase === undefined
        ? {}
        : { has_srt_passphrase: passphrase !== null }),
      ...(notesChanged ? { notes_revision: row.notes_revision + 1 } : {}),
      // Keys leave the settings as they are at this write, the way the real
      // statement filters the column rather than replacing it.
      ...(keptEngineSettingKeys === undefined
        ? {}
        : {
            engine_settings: Object.fromEntries(
              Object.entries(row.engine_settings).filter(([key]) => keptEngineSettingKeys.includes(key)),
            ),
          }),
    });
  }

  async updateNotes(
    name: string,
    notes: string | null,
    expectedRevision: number,
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || row.notes_revision !== expectedRevision) return null;
    return this.write(name, { notes, notes_revision: row.notes_revision + 1 });
  }

  async updateEngineSettings(
    name: string,
    settings: EngineSettings,
    owner: EngineSettingsWriteOwner,
  ): Promise<Profile | null> {
    const profile = this.rows.get(name);
    const revision = this.settingsRevisions.get(name) ?? 0;
    if (!profile || profile.instance_id !== owner.instanceId || profile.intent_revision !== owner.intentRevision ||
        profile.engine_config_revision !== owner.configRevision || profile.stack_version_id !== owner.stackVersionId ||
        profile.status !== 'DEPLOYING' || this.activeDeployJobs.get(name) !== owner.jobReferenceId ||
        revision !== owner.settingsRevision) return null;
    this.settingsRevisions.set(name, revision + 1);
    return this.write(name, { engine_settings: settings });
  }

  async engineConfigOf(name: string): Promise<string | null> {
    return this.engineConfigs.get(name) ?? null;
  }

  async setEngineConfig(
    name: string,
    config: string | null,
    error: string | null,
  ): Promise<Profile | null> {
    if (config === null) this.engineConfigs.delete(name);
    else this.engineConfigs.set(name, config);
    return this.write(name, {
      has_engine_config: config !== null,
      engine_config_error: error,
    });
  }

  async privateKeyOf(name: string): Promise<string | null> {
    return this.privateKeys.get(name) ?? null;
  }

  async rpcEndpointOf(
    name: string,
    owner?: ExpectedDeployOwner,
  ): Promise<{ rpcEndpoint: string | null } | null> {
    const profile = this.rows.get(name);
    if (!profile) return null;
    if (owner && (
      profile.instance_id !== owner.instanceId ||
      profile.intent_revision !== owner.intentRevision ||
      profile.engine_config_revision !== owner.configRevision ||
      profile.stack_version_id !== owner.stackVersionId
    )) return null;
    return { rpcEndpoint: this.rpcEndpoints.get(name) ?? null };
  }

  async rpcEndpointForDeploy(
    name: string,
    owner: ExpectedDeployOwner,
    jobReferenceId: number | null,
  ): Promise<{ rpcEndpoint: string | null } | null> {
    const snapshot = await this.rpcEndpointOf(name, owner);
    const profile = this.rows.get(name);
    if (!snapshot || profile?.status !== 'DEPLOYING') return null;
    if ((this.activeDeployJobs.get(name) ?? null) !== jobReferenceId) return null;
    return snapshot;
  }

  async srtPassphraseOf(name: string): Promise<string | null> {
    return this.passphrases.get(name) ?? null;
  }

  async stackSecretsOf(name: string): Promise<StackSecrets> {
    return { ...(this.secrets.get(name) ?? {}) };
  }

  async stackSettingsForDeploy(name: string): Promise<Record<string, string>> {
    return { ...(this.stackSettings.get(name) ?? {}) };
  }

  async stackSettingsOf(name: string): Promise<StoredStackSettings | null> {
    const row = this.rows.get(name);
    if (!row) return null;
    const plain: Record<string, string> = {};
    const secretKeys: string[] = [];
    for (const [key, value] of Object.entries(this.stackSettings.get(name) ?? {})) {
      if (isSecretSettingKey(key)) secretKeys.push(key);
      else plain[key] = value;
    }
    return {
      plain,
      secretKeys: secretKeys.sort(),
      engine: { ...row.engine_settings },
      revision: this.settingsRevisions.get(name) ?? 0,
      adminTokenOrigin: this.adminTokenOrigins.get(name) ?? null,
    };
  }

  async bindAdminTokenOrigin(name: string, origin: string): Promise<void> {
    if ((this.adminTokenOrigins.get(name) ?? null) === null) this.adminTokenOrigins.set(name, origin);
  }

  async updateStackSettings(
    name: string,
    change: StackSettingsChange,
    guard: { instanceId: string; expectedRevision: number },
  ): Promise<number | null> {
    const row = this.rows.get(name);
    const revision = this.settingsRevisions.get(name) ?? 0;
    if (!row || row.instance_id !== guard.instanceId || revision !== guard.expectedRevision) return null;
    const next = { ...(this.stackSettings.get(name) ?? {}) };
    for (const key of change.remove) delete next[key];
    this.stackSettings.set(name, { ...next, ...change.plain, ...change.secret });
    if (change.adminTokenOrigin !== undefined) this.adminTokenOrigins.set(name, change.adminTokenOrigin);
    const engine = { ...row.engine_settings };
    for (const key of change.engine.remove) delete engine[key];
    this.write(name, { engine_settings: { ...engine, ...change.engine.set } });
    this.settingsRevisions.set(name, revision + 1);
    return revision + 1;
  }

  async storeStackSecrets(name: string, secrets: StackSecrets): Promise<void> {
    this.secrets.set(name, { ...(this.secrets.get(name) ?? {}), ...secrets });
  }

  /** Unconditional, as the real UPDATE is: whoever writes last is what the row records. */
  async updateStampId(name: string, stampId: string): Promise<Profile | null> {
    return this.write(name, { stamp_id: stampId });
  }

  async setLastFullDeployCommit(name: string, commit: string): Promise<void> {
    this.write(name, { last_full_deploy_commit: commit });
  }

  /** Stop, start, edit, remove, apply and reset each move the intent, so an older rollout ends. */
  async bumpIntent(name: string, expectedInstanceId?: string): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row) return null;
    if (expectedInstanceId !== undefined && row.instance_id !== expectedInstanceId) return null;
    return this.write(name, { intent_revision: row.intent_revision + 1 });
  }

  write(name: string, patch: Partial<Profile>): Profile | null {
    const row = this.rows.get(name);
    if (!row) return null;
    const next: Profile = { ...row, ...patch, updated_at: new Date() };
    this.rows.set(name, next);
    return next;
  }
}

export class FakeContainers {
  readonly snapshots: {
    profileName: string;
    service: string;
    ports: Record<string, number>;
    env: Record<string, string>;
    envDigests: Record<string, string>;
    envSalt: string;
  }[] = [];

  asRepository(): ContainerRepository {
    return this as unknown as ContainerRepository;
  }

  async upsert(profileName: string, snapshot: ContainerSnapshot): Promise<void> {
    this.snapshots.push({
      profileName,
      service: snapshot.service,
      ports: snapshot.ports,
      env: snapshot.env,
      envDigests: snapshot.envDigests,
      envSalt: snapshot.envSalt,
    });
  }

  /** `<profile>/<service>` to what the container was seen to run, as `setBuild` recorded it. */
  readonly builds = new Map<string, { buildId: string; commit: string | null }>();

  /** When set, `setBuild` throws, the way a database that went away would. */
  failSetBuild = false;

  async setBuild(profileName: string, service: string, buildId: string, commit: string | null): Promise<void> {
    if (this.failSetBuild) throw new Error('the database went away');
    this.builds.set(`${profileName}/${service}`, { buildId, commit });
  }

  async listApiContainers(): Promise<ApiContainer[]> {
    return [];
  }

  /** The latest record of each service of a deployment, the way the table keeps one row per service. */
  async listForProfile(profileName: string): Promise<ContainerRow[]> {
    const latest = new Map<string, ContainerRow>();
    for (const snapshot of this.snapshots.filter((recorded) => recorded.profileName === profileName)) {
      latest.set(snapshot.service, {
        profile_name: profileName,
        service: snapshot.service,
        ports: snapshot.ports,
        env: snapshot.env,
        env_salt: snapshot.envSalt,
        env_digests: snapshot.envDigests,
        build_id: null,
        build_commit: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      });
    }
    return [...latest.values()].sort((left, right) => left.service.localeCompare(right.service));
  }

  async withContainers(profile: Profile): Promise<ProfileWithContainers> {
    // The real repository resolves this through the ssh config. A fixture takes
    // the host as declared, so no unit test ever forks ssh.
    return {
      ...profile,
      containers: [],
      pendingStamp: isPendingStamp(profile),
      network_host: profile.host ?? '',
    };
  }
}
