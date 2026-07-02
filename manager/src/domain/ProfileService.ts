import { getErrorMessage } from '@streaming-infra-manager/common';

import {
  DeploymentGroupRepository,
  MemberConfigWrite,
  SharedProfileParams,
} from './DeploymentGroupRepository.js';

import {
  DeploymentGroup,
  Profile,
  ProfileKind,
  ProfileWithContainers,
  TRANSITIONAL_STATUSES,
} from '../types/index.js';

import { ContainerRepository } from './ContainerRepository.js';
import { DeploymentOrchestrator } from './DeploymentOrchestrator.js';
import {
  AllSlotsUsedError,
  GroupBusyError,
  GroupExistsError,
  GroupNotFoundError,
  ProfileBusyError,
  ProfileExistsError,
  ProfileNotFoundError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { isPendingStamp } from './stampLogic.js';

const logger = Logger.getInstance();

interface PgError {
  code?: string;
  constraint?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

export class ProfileService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly events: EventBus,
    private readonly groupRepo: DeploymentGroupRepository,
  ) {}

  private publishChanged(profile: ProfileWithContainers): void {
    this.events.publish({ type: 'profile.changed', profile });
  }

  async create(input: {
    name: string;
    kind: ProfileKind;
    notes?: string | null;
    components?: string[] | null;
    host?: string | null;
    feed_owner?: string | null;
    feed_topic?: string | null;
    private_key?: string | null;
    public_key?: string | null;
    stamp_id?: string | null;
  }): Promise<ProfileWithContainers> {
    const existing = await this.repo.findByName(input.name);
    if (existing) {
      throw new ProfileExistsError(input.name);
    }

    let row;
    try {
      row = await this.repo.insertWithFreeSlot(
        input.name,
        input.kind,
        'DEPLOYING',
        {
          notes: input.notes,
          components: input.components?.length ? input.components : undefined,
          host: input.host,
          feed_owner: input.feed_owner,
          feed_topic: input.feed_topic,
          private_key: input.private_key,
          public_key: input.public_key,
          stamp_id: input.stamp_id,
        },
      );
    } catch (err) {
      const pgErr = err as PgError;
      if (
        pgErr.code === PG_UNIQUE_VIOLATION &&
        pgErr.constraint === 'profiles_pkey'
      ) {
        throw new ProfileExistsError(input.name);
      }
      throw err;
    }
    if (!row) {
      throw new AllSlotsUsedError();
    }

    logger.info(
      `[ProfileService] Created profile ${input.name} (kind=${input.kind}, slot=${row.port_slot})`,
    );
    const withContainers = await this.containers.withContainers(row);
    this.publishChanged(withContainers);

    try {
      await this.orchestrator.startInitialDeploy(
        row,
        input.components ?? undefined,
        { host: input.host ?? undefined },
      );
    } catch (err) {
      const errored = await this.repo.markError(
        input.name,
        getErrorMessage(err),
      );
      if (errored) {
        const withContainers = await this.containers.withContainers(errored);
        this.publishChanged(withContainers);
      }
      throw err;
    }

    return withContainers;
  }

  async list(): Promise<ProfileWithContainers[]> {
    const rows = await this.repo.list();
    return Promise.all(rows.map((row) => this.containers.withContainers(row)));
  }

  async getByName(name: string): Promise<ProfileWithContainers> {
    const row = await this.repo.findByName(name);
    if (!row) throw new ProfileNotFoundError(name);
    return this.containers.withContainers(row);
  }

  async update(
    name: string,
    input: {
      notes?: string | null;
      feed_owner?: string | null;
      feed_topic?: string | null;
      private_key?: string | null;
      public_key?: string | null;
      stamp_id?: string | null;
    },
  ): Promise<ProfileWithContainers> {
    const existing = await this.getByName(name);
    if (
      (TRANSITIONAL_STATUSES as readonly string[]).includes(existing.status)
    ) {
      throw new ProfileBusyError(name, existing.status);
    }

    const row = await this.repo.updateEditable(name, existing.kind, {
      notes: input.notes,
      components: existing.components,
      feed_owner: input.feed_owner,
      feed_topic: input.feed_topic,
      private_key: input.private_key,
      public_key: input.public_key,
      stamp_id: input.stamp_id,
    });

    if (!row) {
      throw new ProfileNotFoundError(name);
    }

    logger.info(`[ProfileService] Updated profile ${name}; redeploying`);

    const withContainers: ProfileWithContainers = {
      ...row,
      containers: existing.containers,
      pendingStamp: isPendingStamp(row),
    };

    this.publishChanged(withContainers);

    try {
      await this.orchestrator.startDeploy(row, row.components ?? undefined);
    } catch (err) {
      const errored = await this.repo.markError(name, getErrorMessage(err));
      if (errored) {
        this.publishChanged(await this.containers.withContainers(errored));
      }
      throw err;
    }

    return this.containers.withContainers(row);
  }

  async remove(
    name: string,
    input: { all?: boolean } = {},
  ): Promise<ProfileWithContainers> {
    const profile = await this.getByName(name);
    if ((TRANSITIONAL_STATUSES as readonly string[]).includes(profile.status)) {
      throw new ProfileBusyError(name, profile.status);
    }
    await this.orchestrator.startRemove(profile, input);
    return { ...profile, status: 'REMOVING' };
  }

  async listGroups(): Promise<DeploymentGroup[]> {
    return this.groupRepo.list();
  }

  async createGroup(input: {
    group_name: string;
    size: number;
    kind: ProfileKind;
    notes?: string | null;
    components?: string[];
    host?: string;
    feed_owner?: string;
    feed_topic?: string;
    private_key?: string;
    public_key?: string;
    stamp_id?: string;
  }): Promise<{ group: DeploymentGroup; profiles: ProfileWithContainers[] }> {
    const existingGroup = await this.groupRepo.findByName(input.group_name);
    if (existingGroup) {
      throw new GroupExistsError(input.group_name);
    }

    const usedNames = new Set((await this.repo.list()).map((p) => p.name));

    // todo string array
    const members: { name: string }[] = [];
    let n = 1;
    while (members.length < input.size) {
      let candidate = `${input.group_name}-profile-${n}`;
      while (usedNames.has(candidate)) {
        n += 1;
        candidate = `${input.group_name}-profile-${n}`;
      }

      usedNames.add(candidate);
      members.push({ name: candidate });
      n += 1;
    }

    const shared: SharedProfileParams = {
      kind: input.kind,
      notes: input.notes ?? null,
      components:
        input.components && input.components.length > 0
          ? input.components
          : null,
      host: input.host ?? null,
      feed_owner: input.feed_owner ?? null,
      feed_topic: input.feed_topic ?? null,
      private_key: input.private_key ?? null,
      public_key: input.public_key ?? null,
      stamp_id: input.stamp_id ?? null,
    };

    const { group, profiles } = await this.groupRepo.createGroupWithMembers(
      input.group_name,
      members,
      shared,
    );

    logger.info(
      `[ProfileService] Created group ${group.name} with ${profiles.length} member(s)`,
    );
    const profilesWithContainers: ProfileWithContainers[] = [];
    for (const p of profiles) {
      const withContainers = await this.containers.withContainers(p);
      profilesWithContainers.push(withContainers);
      this.publishChanged(withContainers);
    }

    return { group, profiles: profilesWithContainers };
  }

  async updateGroupConfig(
    groupId: number,
    input: {
      notes?: string | null;
      feed_owner?: string | null;
      feed_topic?: string | null;
      stamp_id?: string | null;
    },
  ): Promise<{ group: DeploymentGroup; profiles: ProfileWithContainers[] }> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    const members = await this.groupRepo.listMembers(groupId);
    if (members.length === 0) {
      throw new GroupNotFoundError(groupId);
    }

    const busy = members
      .filter((m) =>
        (TRANSITIONAL_STATUSES as readonly string[]).includes(m.status),
      )
      .map((m) => m.name);
    if (busy.length > 0) {
      throw new GroupBusyError(group.name, busy);
    }

    // Merge the requested changes onto each member. `undefined` means "not in
    // the request → keep the member's current value"; an explicit value (incl.
    // null) is applied to every member.
    const pick = <T>(next: T | undefined, current: T): T =>
      next !== undefined ? next : current;

    const writes: MemberConfigWrite[] = members.map((m) => ({
      name: m.name,
      kind: m.kind,
      notes: pick(input.notes, m.notes),
      components: m.components,
      feed_owner: pick(input.feed_owner, m.feed_owner),
      feed_topic: pick(input.feed_topic, m.feed_topic),
      private_key: m.private_key,
      public_key: m.public_key,
      stamp_id: pick(input.stamp_id, m.stamp_id),
    }));

    const updated = await this.groupRepo.updateMembersConfig(writes);

    logger.info(
      `[ProfileService] Updated group ${group.name} (${updated.length} member(s)); redeploying`,
    );

    const profiles: ProfileWithContainers[] = [];
    for (const row of updated) {
      this.publishChanged(await this.containers.withContainers(row));
      try {
        await this.orchestrator.startDeploy(row, row.components ?? undefined);
      } catch (err) {
        const errored = await this.repo.markError(
          row.name,
          getErrorMessage(err),
        );
        if (errored) {
          this.publishChanged(await this.containers.withContainers(errored));
        }
      }
      
      const latest = await this.repo.findByName(row.name);
      if (!latest) {
        throw new ProfileNotFoundError(row.name);
      }

      profiles.push(await this.containers.withContainers(latest));
    }

    return { group, profiles };
  }

  async addGroupMembers(
    groupId: number,
    count: number,
  ): Promise<{ group: DeploymentGroup; profiles: ProfileWithContainers[] }> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    const members = await this.groupRepo.listMembers(groupId);
    if (members.length === 0) {
      throw new GroupNotFoundError(groupId);
    }

    const canonical = members[0]!;
    const shared: SharedProfileParams = {
      kind: canonical.kind,
      notes: canonical.notes,
      components: canonical.components,
      host: canonical.host,
      feed_owner: canonical.feed_owner,
      feed_topic: canonical.feed_topic,
      private_key: canonical.private_key,
      public_key: canonical.public_key,
      stamp_id: canonical.stamp_id,
    };

    // Generate the next free `<group>-profile-N` names, skipping any taken.
    const usedNames = new Set((await this.repo.list()).map((p) => p.name));
    const seeds: { name: string }[] = [];
    let n = 1;
    while (seeds.length < count) {
      let candidate = `${group.name}-profile-${n}`;
      while (usedNames.has(candidate)) {
        n += 1;
        candidate = `${group.name}-profile-${n}`;
      }
      usedNames.add(candidate);
      seeds.push({ name: candidate });
      n += 1;
    }

    const created = await this.groupRepo.addMembers(groupId, seeds, shared);

    const refreshed = (await this.groupRepo.findById(groupId)) ?? group;
    logger.info(
      `[ProfileService] Added ${created.length} member(s) to group ${group.name} (size now ${refreshed.size})`,
    );

    const profiles: ProfileWithContainers[] = [];
    for (const p of created) {
      const withContainers = await this.containers.withContainers(p);
      profiles.push(withContainers);
      this.publishChanged(withContainers);
    }

    return { group: refreshed, profiles };
  }
}
