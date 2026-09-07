import {
  type EngineSettings,
  isPendingStamp,
} from '@streaming-infra-manager/common';

import { ContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import type { StackSecrets } from '../../src/domain/versions/stackSecrets.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import {
  NewProfilePlacement,
  ProfileRepository,
  ProfileWriteData,
} from '../../src/domain/ProfileRepository.js';
import {
  ApiContainer,
  Profile,
  ProfileKind,
  ProfileStatus,
  ProfileWithContainers,
} from '../../src/types/index.js';

export function makeProfile(over: Partial<Profile> = {}): Profile {
  return {
    name: 'stage',
    port_slot: 1,
    kind: 'streamer',
    notes: null,
    notes_revision: 0,
    components: null,
    host: null,
    feed_owner: null,
    feed_topic: null,
    private_key: null,
    public_key: null,
    stamp_id: null,
    bee_publishers: null,
    bee_url: null,
    srt_passphrase: null,
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    stack_version_id: 1,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    group_id: null,
    ...over,
  };
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

  readonly updateEditableCalls: string[] = [];

  /** Names whose claim is refused, as though another caller took it first. */
  readonly claimsRefused = new Set<string>();

  /** Names whose `updateEditable` throws, standing in for a rejected write. */
  readonly writesRefused = new Set<string>();

  /** The `stack_secrets` column, kept apart from the rows the way the real one is read. */
  readonly secrets = new Map<string, StackSecrets>();

  /** The `engine_config` column, kept apart from the rows for the same reason. */
  readonly engineConfigs = new Map<string, string>();

  constructor(profiles: readonly Profile[] = []) {
    for (const profile of profiles) this.rows.set(profile.name, profile);
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

  async list(): Promise<Profile[]> {
    return [...this.rows.values()];
  }

  /** The next slot is the next number: no gaps, the way a fresh host fills up. */
  async insertWithFreeSlot(
    name: string,
    kind: ProfileKind,
    status: ProfileStatus,
    data: ProfileWriteData,
    placement: NewProfilePlacement,
  ): Promise<Profile | null> {
    if (this.rows.has(name)) throw new Error(`duplicate profile name: ${name}`);
    const slot = this.rows.size + 1;
    if (slot > placement.maxSlot) return null;
    const row = makeProfile({
      name,
      kind,
      status,
      ...definedFields(data),
      port_slot: slot,
      stack_version_id: placement.stackVersionId,
    });
    this.rows.set(name, row);
    return row;
  }

  async transitionStatus(
    name: string,
    next: ProfileStatus,
    allowedFrom: readonly ProfileStatus[],
  ): Promise<Profile | null> {
    const row = this.rows.get(name);
    if (!row || this.claimsRefused.has(name)) return null;
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
  ): Promise<Profile | null> {
    return this.write(name, {
      status,
      last_error: null,
      last_error_at: null,
    });
  }

  async markError(name: string, message: string): Promise<Profile | null> {
    this.markErrorCalls.push(name);
    return this.write(name, {
      status: 'ERROR',
      last_error: message,
      last_error_at: new Date(),
    });
  }

  async updateEditable(
    name: string,
    kind: ProfileKind,
    data: ProfileWriteData = {},
    engineSettings?: EngineSettings,
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
    const fields = definedFields(data);
    const notesChanged = 'notes' in fields && fields.notes !== row.notes;
    return this.write(name, {
      kind,
      ...fields,
      ...(notesChanged ? { notes_revision: row.notes_revision + 1 } : {}),
      ...(engineSettings === undefined ? {} : { engine_settings: engineSettings }),
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
  ): Promise<Profile | null> {
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

  async stackSecretsOf(name: string): Promise<StackSecrets> {
    return { ...(this.secrets.get(name) ?? {}) };
  }

  async storeStackSecrets(name: string, secrets: StackSecrets): Promise<void> {
    this.secrets.set(name, { ...(this.secrets.get(name) ?? {}), ...secrets });
  }

  private write(name: string, patch: Partial<Profile>): Profile | null {
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
  }[] = [];

  asRepository(): ContainerRepository {
    return this as unknown as ContainerRepository;
  }

  async upsert(profileName: string, snapshot: ContainerSnapshot): Promise<void> {
    this.snapshots.push({
      profileName,
      service: snapshot.service,
      ports: snapshot.ports,
    });
  }

  async listApiContainers(): Promise<ApiContainer[]> {
    return [];
  }

  async withContainers(profile: Profile): Promise<ProfileWithContainers> {
    return { ...profile, containers: [], pendingStamp: isPendingStamp(profile) };
  }
}
