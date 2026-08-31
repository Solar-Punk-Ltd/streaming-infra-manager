import {
  ABR_LADDER_GROUP_KIND,
  ABR_RUNG_COMPONENTS,
  assembleBeePublishers,
  type BeePublishersResult,
  type GroupKind,
  getErrorMessage,
  isLadderKind,
  ladderMemberNames,
  type PublishUrlState,
  rungFromMemberName,
  rungOrder,
  STANDARD_GROUP_KIND,
  type StampHealth,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

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
  LadderGroupError,
  ProfileBusyError,
  ProfileExistsError,
  ProfileNotFoundError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { beePublicApiUrlFor } from './StampService.js';
import { isPendingStamp } from './stampLogic.js';

const logger = Logger.getInstance();

interface PgError {
  code?: string;
  constraint?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Asks a rung's own bee node what state the batch recorded on it is in.
 *
 * Injected as functions rather than the whole StampService so this service keeps
 * depending on nothing that talks to bee. Implemented by
 * `StampService.stampHealthFor`, which never throws and answers `'unknown'` for a
 * node it cannot reach.
 */
export type StampHealthProbe = (
  profile: Profile,
  stampId: string | null | undefined,
) => Promise<StampHealth>;

/**
 * Asks whether a bee node answers at the address the ladder publishes.
 *
 * A separate probe from the one above, and deliberately so: that one reaches a
 * local node through `host.docker.internal`, while this one uses the URL an
 * uploader elsewhere is actually handed. Verifying the first proves nothing about
 * the second. Implemented by `StampService.publishUrlStateFor`.
 */
export type PublishUrlProbe = (url: string) => Promise<PublishUrlState>;

// The honest answers for a caller wired without probes: nothing asked, so nothing
// is known. Readiness treats both as unverified, which is exactly what they are.
const NO_STAMP_PROBE: StampHealthProbe = async (_profile, stampId) =>
  stampHealthFrom(stampId, null);
const NO_URL_PROBE: PublishUrlProbe = async () => 'unknown';

export class ProfileService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly events: EventBus,
    private readonly groupRepo: DeploymentGroupRepository,
    private readonly probeStampHealth: StampHealthProbe = NO_STAMP_PROBE,
    private readonly probePublishUrl: PublishUrlProbe = NO_URL_PROBE,
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

  /**
   * Members of a ladder, in ascending rung order.
   *
   * Ladder-ness is derived from the member names, never stored: a group that
   * stops looking like a ladder — a rung removed — stops being treated as one,
   * which is the honest answer rather than a stale flag on the group row.
   */
  private async ladderMembersOf(
    group: DeploymentGroup,
  ): Promise<{ rung: string; profile: Profile }[]> {
    const members = await this.groupRepo.listMembers(group.id);
    return members
      .map((profile) => ({
        rung: rungFromMemberName(group.name, profile.name),
        profile,
      }))
      .filter((m): m is { rung: string; profile: Profile } => m.rung !== null)
      .sort((a, b) => rungOrder(a.rung) - rungOrder(b.rung));
  }

  private assertNotLadder(group: DeploymentGroup, reason: string): void {
    if (isLadderKind(group.kind)) {
      throw new LadderGroupError(group.name, reason);
    }
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
    abr_ladder?: boolean;
  }): Promise<{ group: DeploymentGroup; profiles: ProfileWithContainers[] }> {
    const existingGroup = await this.groupRepo.findByName(input.group_name);
    if (existingGroup) {
      throw new GroupExistsError(input.group_name);
    }

    const usedNames = new Set((await this.repo.list()).map((p) => p.name));

    const members: { name: string }[] = [];

    if (input.abr_ladder) {
      // A ladder's names are not negotiable — the rung lives in the name, so a
      // taken name cannot be skipped past the way a fan-out member can. Fail
      // loudly instead of quietly building a ladder with a gap in it.
      for (const name of ladderMemberNames(input.group_name)) {
        if (usedNames.has(name)) {
          throw new ProfileExistsError(name);
        }
        usedNames.add(name);
        members.push({ name });
      }
    } else {
      // todo string array
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
    }

    const shared: SharedProfileParams = {
      kind: input.kind,
      notes: input.notes ?? null,
      components: input.abr_ladder
        ? [...ABR_RUNG_COMPONENTS]
        : input.components && input.components.length > 0
          ? input.components
          : null,
      host: input.host ?? null,
      feed_owner: input.feed_owner ?? null,
      feed_topic: input.feed_topic ?? null,
      private_key: input.private_key ?? null,
      public_key: input.public_key ?? null,
      stamp_id: input.stamp_id ?? null,
    };

    const kind: GroupKind = input.abr_ladder
      ? ABR_LADDER_GROUP_KIND
      : STANDARD_GROUP_KIND;

    const { group, profiles } = await this.groupRepo.createGroupWithMembers(
      input.group_name,
      kind,
      members,
      shared,
    );

    logger.info(
      `[ProfileService] Created group ${group.name} with ${profiles.length} member(s)` +
        `${input.abr_ladder ? ' (ABR ladder)' : ''}`,
    );
    const profilesWithContainers: ProfileWithContainers[] = [];
    for (const p of profiles) {
      const withContainers = await this.containers.withContainers(p);
      profilesWithContainers.push(withContainers);
      this.publishChanged(withContainers);
    }

    return { group, profiles: profilesWithContainers };
  }

  /**
   * The BEE_PUBLISHERS value for a ladder group.
   *
   * Emitted only when every rung has a batch that will still be honoured.
   * `BeePublisherPool.perRung` refuses a ladder with a rung missing, so a partial
   * string would fail later and less clearly than naming the rung that is not
   * ready — and a string built from expired batches is worse again, because it
   * looks finished and fails on every upload.
   *
   * Neither the profile row nor the composed URL can answer that on its own:
   *
   *  - `profiles.stamp_id` records which batch a rung was pointed at, not whether
   *    the batch is still alive. Batches are paid, finite leases; they run out on
   *    their own and nothing writes that back.
   *  - the URL is `PUBLIC_HOST` plus `10005 + slot*10`, so it always *looks* like
   *    an address whether or not anything is there — and it is composed from a
   *    field that holds a *deploy* target, which may be an ssh alias or
   *    `user@host` rather than a network address.
   *
   * So each rung is checked twice, all rungs in parallel on a short timeout: its
   * node is asked about its batch, and the exact address that goes into the string
   * is asked whether anything answers. A check that cannot be completed leaves its
   * rung *unverified* rather than unready — an unreachable node or a public address
   * the manager cannot loop back to is not evidence of a fault, so it degrades to a
   * caution instead of a false alarm.
   */
  async beePublishersForGroup(groupId: number): Promise<BeePublishersResult> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    if (!isLadderKind(group.kind)) {
      throw new LadderGroupError(
        group.name,
        'this group is not an ABR ladder, so it has no BEE_PUBLISHERS to assemble',
      );
    }

    const members = await this.ladderMembersOf(group);
    const urls = members.map(({ profile }) => beePublicApiUrlFor(profile));

    // Both probes swallow their own failures; the catches guard an injected probe
    // that does not, so one bad node can never fail the whole request.
    const [stamps, urlStates] = await Promise.all([
      Promise.all(
        members.map(({ profile }) =>
          this.probeStampHealth(profile, profile.stamp_id).catch((err) => {
            logger.warn(
              `[ProfileService] ${profile.name}: stamp probe threw: ${getErrorMessage(err)}`,
            );
            return stampHealthFrom(profile.stamp_id, null);
          }),
        ),
      ),
      Promise.all(
        urls.map((url, index) =>
          this.probePublishUrl(url).catch((err) => {
            logger.warn(
              `[ProfileService] ${members[index]!.profile.name}: url probe threw: ${getErrorMessage(err)}`,
            );
            return 'unknown' as PublishUrlState;
          }),
        ),
      ),
    ]);

    return assembleBeePublishers(
      members.map(({ rung, profile }, index) => ({
        rung,
        name: profile.name,
        status: profile.status,
        url: urls[index]!,
        stampId: profile.stamp_id,
        stampState: stamps[index]!.state,
        stampTtl: stamps[index]!.ttl,
        urlState: urlStates[index],
      })),
    );
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

    // Bulk-applying one stamp across a ladder would hand every rung the same
    // batch, which is exactly the failure a node per rung exists to prevent:
    // the batches are deliberately different sizes, bought per rung. Other
    // shared fields stay bulk-editable.
    if (input.stamp_id !== undefined && isLadderKind(group.kind)) {
      throw new LadderGroupError(
        group.name,
        'each rung pays with its own postage batch, so a stamp cannot be applied to the whole group — buy one per rung from the Uploaders tab',
      );
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

    // `<group>-profile-N` is not a rung name, so an appended member would sit in
    // the group without ever being part of the ladder.
    this.assertNotLadder(
      group,
      'its members are fixed to one per quality rung, so members cannot be appended',
    );

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
