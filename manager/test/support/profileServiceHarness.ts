import { EventEmitter } from 'node:events';

import type { GroupKind } from '@streaming-infra-manager/common';

import {
  DeploymentGroupRepository,
  MemberConfigWrite,
  MemberSeed,
  SharedProfileParams,
} from '../../src/domain/DeploymentGroupRepository.js';
import {
  DeploymentOrchestrator,
  DeployReservation,
} from '../../src/domain/DeploymentOrchestrator.js';
import { ProfileBusyError } from '../../src/domain/errors/index.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { ProfileService } from '../../src/domain/ProfileService.js';
import { RunHandle } from '../../src/domain/ScriptRunner.js';
import { BUNDLED_STACK_ROOT } from '../../src/utils/envUtils.js';
import { DeploymentGroup, Profile, ProfileStatus } from '../../src/types/index.js';

import { InMemoryStackVersionRepository } from './InMemoryStackVersionRepository.js';
import { FakeContainers, InMemoryProfiles, makeProfile } from './profileFixtures.js';

const REDEPLOYABLE_FROM: readonly ProfileStatus[] = [
  'RUNNING',
  'STOPPED',
  'ERROR',
];

function finishedHandle(): RunHandle {
  const emitter = new EventEmitter();
  setImmediate(() => emitter.emit('done', { code: 0 }));
  return { emitter, kill: () => undefined };
}

export interface RecordedDeploy {
  profileName: string;
  services: readonly string[];
}

/**
 * A DeploymentOrchestrator that records instead of deploying, keeping the two
 * rules the real one is bound by: a claim moves the profile into DEPLOYING or
 * is refused outright, and a failure once the claim is held marks the profile
 * ERROR through the repository.
 */
export class FakeOrchestrator {
  readonly reserved: string[] = [];

  readonly cancelled: string[] = [];

  readonly deploys: RecordedDeploy[] = [];

  /** Profiles whose deploy fails once the claim is held. */
  readonly failingDeploys = new Set<string>();

  constructor(private readonly profiles: InMemoryProfiles) {}

  asOrchestrator(): DeploymentOrchestrator {
    return this as unknown as DeploymentOrchestrator;
  }

  /** Every fake row runs the bundled checkout, the one SHLS_ROOT names. */
  async stackRootFor(): Promise<string> {
    return BUNDLED_STACK_ROOT;
  }

  async reserveDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<DeployReservation> {
    const claimed = await this.profiles.transitionStatus(
      profile.name,
      'DEPLOYING',
      REDEPLOYABLE_FROM,
    );
    if (!claimed) {
      const current = await this.profiles.findByName(profile.name);
      throw new ProfileBusyError(profile.name, current?.status ?? 'REMOVING');
    }
    this.reserved.push(profile.name);
    return {
      profileName: profile.name,
      services: requested ?? [],
      heldBackForStamp: [],
      previousStatus: profile.status,
      transitioned: true,
    };
  }

  async cancelReservation(reservation: DeployReservation): Promise<void> {
    this.cancelled.push(reservation.profileName);
    if (reservation.transitioned) {
      await this.profiles.markTerminal(
        reservation.profileName,
        reservation.previousStatus,
      );
    }
  }

  async runReserved(
    reservation: DeployReservation,
    profile: Profile,
  ): Promise<RunHandle> {
    this.deploys.push({
      profileName: profile.name,
      services: reservation.services,
    });
    if (this.failingDeploys.has(profile.name)) {
      const message = `deploy could not start for ${profile.name}`;
      await this.profiles.markError(profile.name, message);
      throw new Error(message);
    }
    return finishedHandle();
  }

  async startDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<RunHandle> {
    const reservation = await this.reserveDeploy(profile, requested);
    return this.runReserved(reservation, profile);
  }

  async startInitialDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<RunHandle> {
    return this.runReserved(
      {
        profileName: profile.name,
        services: requested ?? [],
        heldBackForStamp: [],
        previousStatus: profile.status,
        transitioned: false,
      },
      profile,
    );
  }
}

export class InMemoryGroups {
  readonly groups: DeploymentGroup[] = [];

  readonly configWrites: MemberConfigWrite[] = [];

  private nextId = 1;

  constructor(private readonly profiles: InMemoryProfiles) {}

  asRepository(): DeploymentGroupRepository {
    return this as unknown as DeploymentGroupRepository;
  }

  async findByName(name: string): Promise<DeploymentGroup | null> {
    return this.groups.find((group) => group.name === name) ?? null;
  }

  async findById(id: number): Promise<DeploymentGroup | null> {
    return this.groups.find((group) => group.id === id) ?? null;
  }

  async list(): Promise<DeploymentGroup[]> {
    return [...this.groups];
  }

  async listMembers(groupId: number): Promise<Profile[]> {
    const rows = await this.profiles.list();
    return rows.filter((row) => row.group_id === groupId);
  }

  async createGroupWithMembers(
    groupName: string,
    kind: GroupKind,
    members: MemberSeed[],
    shared: SharedProfileParams,
  ): Promise<{ group: DeploymentGroup; profiles: Profile[] }> {
    const group: DeploymentGroup = {
      id: this.nextId++,
      name: groupName,
      size: members.length,
      kind,
      created_at: new Date(0),
    };
    this.groups.push(group);
    return {
      group,
      profiles: members.map((member) => this.insert(member.name, shared, group.id)),
    };
  }

  async addMembers(
    groupId: number,
    members: MemberSeed[],
    shared: SharedProfileParams,
  ): Promise<Profile[]> {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    if (group) group.size += members.length;
    return members.map((member) => this.insert(member.name, shared, groupId));
  }

  async updateMembersConfig(writes: MemberConfigWrite[]): Promise<Profile[]> {
    this.configWrites.push(...writes);
    const updated: Profile[] = [];
    for (const write of writes) {
      const row = await this.profiles.updateEditable(write.name, write.kind, {
        notes: write.notes,
        components: write.components,
        feed_owner: write.feed_owner,
        feed_topic: write.feed_topic,
        private_key: write.private_key,
        public_key: write.public_key,
        stamp_id: write.stamp_id,
        srt_passphrase: write.srt_passphrase,
      });
      if (row) updated.push(row);
    }
    return updated;
  }

  /** Members are created STOPPED, the way the real insert does it. */
  private insert(
    name: string,
    shared: SharedProfileParams,
    groupId: number,
  ): Profile {
    const row = makeProfile({
      name,
      kind: shared.kind,
      notes: shared.notes,
      components: shared.components,
      host: shared.host,
      feed_owner: shared.feed_owner,
      feed_topic: shared.feed_topic,
      private_key: shared.private_key,
      public_key: shared.public_key,
      stamp_id: shared.stamp_id,
      srt_passphrase: shared.srt_passphrase,
      stack_version_id: shared.stack_version_id,
      status: 'STOPPED',
      port_slot: this.profiles.rows.size + 1,
      group_id: groupId,
    });
    this.profiles.rows.set(name, row);
    return row;
  }
}

export interface ProfileServiceHarness {
  service: ProfileService;
  profiles: InMemoryProfiles;
  containers: FakeContainers;
  groups: InMemoryGroups;
  orchestrator: FakeOrchestrator;
  events: EventBus;
  /** Seeded with the bundled version as the default, the way a host starts. */
  versions: InMemoryStackVersionRepository;
}

export function profileServiceHarness(
  rows: readonly Profile[] = [],
): ProfileServiceHarness {
  const profiles = new InMemoryProfiles(rows);
  const containers = new FakeContainers();
  const groups = new InMemoryGroups(profiles);
  const orchestrator = new FakeOrchestrator(profiles);
  const events = new EventBus();
  const versions = new InMemoryStackVersionRepository();
  versions.seedBundled();

  const service = new ProfileService(
    profiles.asRepository(),
    containers.asRepository(),
    orchestrator.asOrchestrator(),
    events,
    groups.asRepository(),
    versions,
  );

  return { service, profiles, containers, groups, orchestrator, events, versions };
}

/** One deploy as the engine settings tests read it. */
export interface EngineDeploy {
  name: string;
  services: string[];
}

export interface EngineSettingsHarness {
  service: ProfileService;
  /** The row as the fake repository holds it now, after every write so far. */
  stored: () => Profile;
  deploys: EngineDeploy[];
}

export function profileRow(overrides: Partial<Profile> = {}): Profile {
  return makeProfile({
    name: 'stream1',
    stamp_id: 'a'.repeat(64),
    ...overrides,
  });
}

/**
 * The harness above for one row, answering what a settings change recreated.
 *
 * The orchestrator fake keeps the claim rule, so a row that is not RUNNING,
 * STOPPED or ERROR is refused the way the real one refuses it.
 */
export function harnessFor(initial: Profile): EngineSettingsHarness {
  const harness = profileServiceHarness([initial]);
  const deploys: EngineDeploy[] = [];
  const orchestrator = harness.orchestrator;
  const runReserved = orchestrator.runReserved.bind(orchestrator);
  orchestrator.runReserved = async (reservation, profile) => {
    deploys.push({ name: profile.name, services: [...reservation.services] });
    return runReserved(reservation, profile);
  };

  return {
    service: harness.service,
    stored: () => {
      const row = harness.profiles.rows.get(initial.name);
      if (!row) throw new Error(`${initial.name} is gone from the fake repository`);
      return row;
    },
    deploys,
  };
}
