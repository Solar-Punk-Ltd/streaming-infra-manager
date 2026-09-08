import {
  ABR_NODE_POOL_GROUP_KIND,
  ABR_RUNG_COMPONENTS,
  applicableEngineSettings,
  assembleEngineSettingObservations,
  assembleBeePublishers,
  type BeePublishersResult,
  beeTargetProblem,
  defaultServicesFor,
  type EngineDefaults,
  type EngineName,
  effectiveEngineDefaults,
  engineOfServices,
  type EngineSettings,
  type EngineSettingsOverview,
  environmentSettingReadings,
  OME_SERVICE,
  engineSettingsFieldsFor,
  engineSettingsProblem,
  type GroupKind,
  getErrorMessage,
  hasBeePublishers,
  isLadderKind,
  ladderMemberNames,
  liveUnavailableReason,
  type PublishUrlState,
  rungFromMemberName,
  rungOrder,
  type StackContract,
  STANDARD_GROUP_KIND,
  type StampHealth,
  stampHealthFrom,
  STREAM_UPLOADER_SERVICE,
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

import { parseBaseEnv } from '../utils/envUtils.js';

import { ContainerRepository } from './ContainerRepository.js';
import { UPLOADER_ENGINE_SETTING_KEYS } from './containerKeysSpec.js';
import {
  DeploymentOrchestrator,
  DeployReservation,
} from './DeploymentOrchestrator.js';
import {
  AllSlotsUsedError,
  GroupBusyError,
  GroupExistsError,
  GroupNotFoundError,
  InvalidStackVersionError,
  LadderGroupError,
  ProfileBusyError,
  ProfileConfigError,
  ProfileExistsError,
  ProfileNotFoundError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { engineTemplateIn } from './engineConfig/engineConfigTemplates.js';
import { omeSettingReadings } from './engineConfig/omeSettingReadings.js';
import { srsSettingReadings } from './engineConfig/srsSettingReadings.js';
import { ProfileRepository } from './ProfileRepository.js';
import { beePublicApiUrlFor } from './StampService.js';
import { isPendingStamp } from './stampLogic.js';
import { maxSlotOf } from './versions/portTable.js';
import type {
  StackVersionRecord,
  StackVersionRepository,
} from './versions/StackVersionRepository.js';

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

/**
 * The containers a settings change has to bring back with the new values.
 *
 * The engine always, and the uploader as well when one of the keys compose
 * hands to the uploader rather than to the engine has a different value than
 * before. Recreating the engine alone in that case leaves the value the
 * operator typed sitting in the database, applied to nothing.
 */
/** What is left of the stored settings once this profile stops encoding a ladder. */
function withoutLadderSettings(profile: Profile): EngineSettings {
  const engine = engineOfServices(defaultServicesFor(profile));
  if (!engine) return profile.engine_settings;
  return applicableEngineSettings(engine, profile.engine_settings, {
    abr: false,
  });
}

function servicesToRecreate(
  engine: EngineName,
  before: EngineSettings,
  after: EngineSettings,
): string[] {
  const uploaderChanged = UPLOADER_ENGINE_SETTING_KEYS.some(
    (key) => before[key] !== after[key],
  );
  return uploaderChanged ? [engine, STREAM_UPLOADER_SERVICE] : [engine];
}

export class ProfileService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly events: EventBus,
    private readonly groupRepo: DeploymentGroupRepository,
    private readonly versions: StackVersionRepository,
    private readonly probeStampHealth: StampHealthProbe = NO_STAMP_PROBE,
    private readonly probePublishUrl: PublishUrlProbe = NO_URL_PROBE,
  ) {}

  private publishChanged(profile: ProfileWithContainers): void {
    this.events.publish({ type: 'profile.changed', profile });
  }

  /**
   * Runs a write that a deploy claim has already been taken for, giving the
   * claim back if the write fails.
   *
   * Without this a profile whose settings could not be written would sit in
   * DEPLOYING with no job to end it.
   */
  private async writeOrCancel<T>(
    reservations: readonly DeployReservation[],
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      await this.cancelAll(reservations);
      throw err;
    }
  }

  private async cancelAll(
    reservations: readonly DeployReservation[],
  ): Promise<void> {
    for (const reservation of reservations) {
      await this.orchestrator.cancelReservation(reservation);
    }
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
    bee_publishers?: string | null;
    bee_url?: string | null;
    srt_passphrase?: string | null;
    /** Absent means the default version. */
    stack_version_id?: number | null;
  }): Promise<ProfileWithContainers> {
    const existing = await this.repo.findByName(input.name);
    if (existing) {
      throw new ProfileExistsError(input.name);
    }

    const version = await this.versionForNewDeployment(input.stack_version_id);

    // The same rule the update path applies, over the same shape. The schema
    // checks these per-field too, with nicer field-scoped messages; this is the
    // one place both paths share, so they cannot drift apart again.
    const configProblem = beeTargetProblem({
      kind: input.kind,
      components: input.components?.length ? input.components : null,
      bee_publishers: input.bee_publishers ?? null,
      bee_url: input.bee_url ?? null,
    });
    if (configProblem) {
      throw new ProfileConfigError(input.name, configProblem);
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
          bee_publishers: input.bee_publishers,
          bee_url: input.bee_url,
          srt_passphrase: input.srt_passphrase,
        },
        { stackVersionId: version.id, maxSlot: maxSlotOf(version.contract) },
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
      throw new AllSlotsUsedError(maxSlotOf(version.contract));
    }

    logger.info(
      `[ProfileService] Created profile ${input.name} (kind=${input.kind}, slot=${row.port_slot}, version=${version.name})`,
    );
    const withContainers = await this.containers.withContainers(row);
    this.publishChanged(withContainers);

    // The orchestrator marks the row ERROR if the deploy cannot start: it owns
    // the row from here, and marking it here too would overwrite the reason.
    await this.orchestrator.startInitialDeploy(
      row,
      input.components ?? undefined,
      { host: input.host ?? undefined },
    );

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
      bee_publishers?: string | null;
      bee_url?: string | null;
      srt_passphrase?: string | null;
    },
  ): Promise<ProfileWithContainers> {
    const existing = await this.getByName(name);
    if (
      (TRANSITIONAL_STATUSES as readonly string[]).includes(existing.status)
    ) {
      throw new ProfileBusyError(name, existing.status);
    }

    // PUT replaces every editable field, so a body that omits bee_publishers
    // clears it. For an abr-uploader that silently removes the only thing it
    // publishes through, and neither yup test can catch it: `kind` and
    // `components` are not in an update body. Checked here, against the state
    // the write would actually leave behind.
    const configProblem = beeTargetProblem({
      kind: existing.kind,
      components: existing.components,
      bee_publishers: input.bee_publishers ?? null,
      bee_url: input.bee_url ?? null,
    });
    if (configProblem) {
      throw new ProfileConfigError(name, configProblem);
    }

    // Turning the ladder off in this same write leaves the rung settings behind,
    // where no drawer renders them and no container reads them. They go out with
    // the pool string, in one statement, so no state exists in which the column
    // holds settings the deployment cannot act on.
    const laddersEnded =
      hasBeePublishers(existing) && !input.bee_publishers?.trim();

    // Claimed before anything is written. Two concurrent PUTs both pass the
    // busy check above, so without the claim the loser would rewrite the row
    // and the env file under the winner's running deploy, then mark the profile
    // ERROR while that deploy was still going.
    const reservation = await this.orchestrator.reserveDeploy(
      existing,
      existing.components ?? undefined,
    );

    const row = await this.writeOrCancel([reservation], async () => {
      const written = await this.repo.updateEditable(name, existing.kind, {
        notes: input.notes,
        components: existing.components,
        feed_owner: input.feed_owner,
        feed_topic: input.feed_topic,
        private_key: input.private_key,
        public_key: input.public_key,
        stamp_id: input.stamp_id,
        bee_publishers: input.bee_publishers,
        bee_url: input.bee_url,
        srt_passphrase: input.srt_passphrase,
      }, laddersEnded ? withoutLadderSettings(existing) : undefined);
      if (!written) {
        throw new ProfileNotFoundError(name);
      }
      return written;
    });

    logger.info(`[ProfileService] Updated profile ${name}; redeploying`);

    const withContainers: ProfileWithContainers = {
      ...row,
      containers: existing.containers,
      pendingStamp: isPendingStamp(row),
    };

    this.publishChanged(withContainers);

    await this.orchestrator.runReserved(reservation, row);

    return this.containers.withContainers(row);
  }

  /**
   * The engine this deployment runs, and whether it encodes the ABR ladder.
   *
   * ABR-ness follows the pool string, because that is what `writeProfileEnv`
   * turns `ABR_ENABLED=true` on for. Reading it any other way would let the
   * settings route accept a value the deploy then refuses.
   */
  /**
   * The version a new deployment runs: the one asked for, else the default.
   *
   * Only a version that finished building can be chosen. A building one has no
   * scripts to run yet, and a failed one has whatever its failed build left
   * behind. Answered as a rejected body either way, because the reason is the
   * only useful text.
   */
  private async versionForNewDeployment(
    id: number | null | undefined,
  ): Promise<StackVersionRecord> {
    const version =
      id == null
        ? await this.versions.findDefault()
        : await this.versions.findById(id);
    if (!version) {
      throw new InvalidStackVersionError(
        id == null
          ? 'No stack version is the default. Set one on the Versions page.'
          : `Stack version ${id} does not exist. Pick one from the Versions page.`,
      );
    }
    if (version.status !== 'ready') {
      throw new InvalidStackVersionError(
        `${version.name} is ${version.status}. Only a version that finished building can run a deployment.`,
      );
    }
    return version;
  }

  private engineFacts(profile: Profile): { engine: EngineName; abr: boolean } {
    const engine = engineOfServices(defaultServicesFor(profile));
    if (!engine) {
      throw new ProfileConfigError(
        profile.name,
        `${profile.name} runs no media server, so it has no engine settings. Only a stream or an ABR uploader has them.`,
      );
    }
    return { engine, abr: hasBeePublishers(profile) };
  }

  /**
   * What an unset setting falls back to on this host, and where each value came
   * from.
   *
   * `.env.<profile>` is a fresh copy of the host's base `.env` on every deploy
   * and an unset key is left out of it, so a key set on the box by hand is what
   * the container starts with. Naming the stack's own value instead would
   * describe a deployment nobody is running.
   */
  private async engineDefaults(
    profile: Profile,
    engine: EngineName,
  ): Promise<EngineDefaults> {
    const root = await this.orchestrator.stackRootFor(profile);
    const contract = await this.contractFor(profile);
    const defaults = effectiveEngineDefaults(
      engine,
      parseBaseEnv(root),
      contract?.engineDefaults ?? {},
    );
    if (defaults.rejected.length > 0) {
      logger.warn(
        `[ProfileService] The base .env sets ${defaults.rejected.join(', ')} to a value ${engine} would refuse. ` +
          'The stack default stands for those.',
      );
    }
    return defaults;
  }

  /** The deploy contract of the version this deployment runs, or null. */
  private async contractFor(profile: Profile): Promise<StackContract | null> {
    const version = await this.versions.findById(profile.stack_version_id);
    return version?.contract ?? null;
  }

  /** What `GET /profiles/:name/engine` answers, minus the live block. */
  async engineOverview(profile: Profile): Promise<EngineSettingsOverview> {
    const { engine, abr } = this.engineFacts(profile);
    const defaults = await this.engineDefaults(profile, engine);
    const contract = await this.contractFor(profile);
    const fields = engineSettingsFieldsFor(engine, { abr });
    let readings = environmentSettingReadings(fields);
    if (profile.has_engine_config) {
      let template: string | null = null;
      try {
        template = engineTemplateIn(await this.orchestrator.stackRootFor(profile), engine).text;
      } catch {
        // Missing or unreadable metadata is represented in each affected observation.
      }
      const storedConfig = await this.repo.engineConfigOf(profile.name);
      readings = engine === OME_SERVICE ? omeSettingReadings(template, storedConfig, fields)
        : srsSettingReadings(template, storedConfig, fields, { abr });
    }
    const observed = assembleEngineSettingObservations({ fields, settings: profile.engine_settings, defaults, readings });
    return {
      engine,
      abr,
      settings: profile.engine_settings,
      defaults: defaults.values,
      defaultSources: defaults.sources,
      ...observed,
      fields,
      liveUnavailableReason: liveUnavailableReason(engine, contract?.features),
    };
  }

  /**
   * Stores the engine settings and recreates the containers that read them.
   *
   * Almost always that is the engine alone, and the Bee node and the uploader
   * are left running because taking them down would interrupt an upload that
   * has nothing to do with the change. The exception is
   * `OME_HLS_POLL_INTERVAL_MS`, which compose puts in the uploader's
   * environment, so a change to it has to recreate the uploader as well or the
   * new value never reaches the process that reads it.
   */
  async updateEngineSettings(
    name: string,
    settings: EngineSettings,
  ): Promise<ProfileWithContainers> {
    const existing = await this.getByName(name);
    if (
      (TRANSITIONAL_STATUSES as readonly string[]).includes(existing.status)
    ) {
      throw new ProfileBusyError(name, existing.status);
    }

    const { engine, abr } = this.engineFacts(existing);
    const problem = engineSettingsProblem(engine, settings, {
      abr,
      defaults: (await this.engineDefaults(existing, engine)).values,
    });
    if (problem) {
      throw new ProfileConfigError(name, problem);
    }

    const services = servicesToRecreate(
      engine,
      existing.engine_settings,
      settings,
    );

    // Claimed before the settings are written, for the same reason the PUT
    // path claims first: two saves that both pass the busy check would both
    // store, and the one refused the deploy would have left its settings behind
    // under the other one's running recreate.
    const reservation = await this.orchestrator.reserveDeploy(
      existing,
      services,
    );

    const row = await this.writeOrCancel([reservation], async () => {
      const written = await this.repo.updateEngineSettings(name, settings);
      if (!written) throw new ProfileNotFoundError(name);
      return written;
    });

    logger.info(
      `[ProfileService] Updated engine settings for ${name}; recreating ${services.join(', ')}`,
    );

    this.publishChanged({
      ...row,
      containers: existing.containers,
      pendingStamp: isPendingStamp(row),
    });

    await this.orchestrator.runReserved(reservation, row);

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
   * Members of a pool, in ascending rung order.
   *
   * Pool-ness itself is *not* derived here — it is `deployment_groups.kind`, so
   * a pool with a rung removed is still a pool, which is the moment an operator
   * most needs it reported as one. What this derives is the narrower question of
   * which rung each member publishes, read from its name; a member whose name
   * carries no rung is not one and is skipped.
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
    srt_passphrase?: string;
    abr_ladder?: boolean;
    /** Absent means the default version. */
    stack_version_id?: number | null;
  }): Promise<{ group: DeploymentGroup; profiles: ProfileWithContainers[] }> {
    // The same invariant updateGroupConfig enforces, at the other door. A pool's
    // rungs each pay with their own batch, sized for that rung's bitrate, so one
    // stamp across all four is exactly the failure a node per rung exists to
    // prevent — and `shared` below is applied to every member, so accepting it
    // here would write it four times. Refusing it only on the update path meant
    // POST could create the state PATCH then refused to change.
    if (input.abr_ladder && input.stamp_id) {
      throw new LadderGroupError(
        input.group_name,
        'each rung buys its own postage batch, so one stamp cannot be set for the whole pool — create it first, then buy per rung from the Uploaders tab',
      );
    }

    const existingGroup = await this.groupRepo.findByName(input.group_name);
    if (existingGroup) {
      throw new GroupExistsError(input.group_name);
    }

    const version = await this.versionForNewDeployment(input.stack_version_id);

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
      srt_passphrase: input.srt_passphrase ?? null,
      stack_version_id: version.id,
      max_slot: maxSlotOf(version.contract),
    };

    const kind: GroupKind = input.abr_ladder
      ? ABR_NODE_POOL_GROUP_KIND
      : STANDARD_GROUP_KIND;

    const { group, profiles } = await this.groupRepo.createGroupWithMembers(
      input.group_name,
      kind,
      members,
      shared,
    );

    logger.info(
      `[ProfileService] Created group ${group.name} with ${profiles.length} member(s)` +
        `${input.abr_ladder ? ' (ABR node pool)' : ''} on ${version.name}; deploying`,
    );

    return { group, profiles: await this.deployNewMembers(profiles) };
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
        'this group is not an ABR node pool, so it has no BEE_PUBLISHERS to assemble',
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
      srt_passphrase?: string | null;
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
      srt_passphrase: pick(input.srt_passphrase, m.srt_passphrase),
    }));

    // Every member is claimed before the bulk write, so a group edit that
    // cannot own all of its deployments changes none of them.
    const reservations = await this.reserveMembers(group, members);

    const updated = await this.writeOrCancel([...reservations.values()], () =>
      this.groupRepo.updateMembersConfig(writes),
    );

    logger.info(
      `[ProfileService] Updated group ${group.name} (${updated.length} member(s)); redeploying`,
    );

    const profiles: ProfileWithContainers[] = [];
    for (const row of updated) {
      this.publishChanged(await this.containers.withContainers(row));

      const reservation = reservations.get(row.name);
      if (reservation) {
        await this.runMember(reservation, row);
      }

      const latest = await this.repo.findByName(row.name);
      if (!latest) {
        throw new ProfileNotFoundError(row.name);
      }

      profiles.push(await this.containers.withContainers(latest));
    }

    return { group, profiles };
  }

  /**
   * A claim on every member's next deployment, or none at all.
   *
   * A member that cannot be claimed gives back the claims already taken, so a
   * half-deployed group edit is not a state the API can produce.
   */
  private async reserveMembers(
    group: DeploymentGroup,
    members: readonly Profile[],
  ): Promise<Map<string, DeployReservation>> {
    const reservations = new Map<string, DeployReservation>();
    for (const member of members) {
      try {
        reservations.set(
          member.name,
          await this.orchestrator.reserveDeploy(
            member,
            member.components ?? undefined,
          ),
        );
      } catch (err) {
        await this.cancelAll([...reservations.values()]);
        if (err instanceof ProfileBusyError) {
          throw new GroupBusyError(group.name, [err.profileName]);
        }
        throw err;
      }
    }
    return reservations;
  }

  /**
   * Starts one member's deploy, letting the rest of the group carry on.
   *
   * The orchestrator has already marked a failed member ERROR with its reason,
   * and the row is re-read afterwards, so the response says per member what
   * happened.
   */
  private async runMember(
    reservation: DeployReservation,
    row: Profile,
  ): Promise<void> {
    try {
      await this.orchestrator.runReserved(reservation, row);
    } catch (err) {
      logger.warn(
        `[ProfileService] ${row.name}: deploy did not start: ${getErrorMessage(err)}`,
      );
    }
  }

  /** Claims and starts one member that has just been created. */
  private async startMember(member: Profile): Promise<void> {
    let reservation: DeployReservation;
    try {
      reservation = await this.orchestrator.reserveDeploy(
        member,
        member.components ?? undefined,
      );
    } catch (err) {
      logger.warn(
        `[ProfileService] ${member.name}: could not be claimed for deploy: ${getErrorMessage(err)}`,
      );
      return;
    }
    await this.runMember(reservation, member);
  }

  /**
   * Deploys the members a group creation or resize has just inserted.
   *
   * A single deployment created through the same wizard is deployed at once, so
   * a group is too: leaving its members STOPPED under a "Deploying" toast said
   * one thing and did another. Each member is read back after its start, so the
   * response carries the status and reason for the ones that did not take.
   */
  private async deployNewMembers(
    created: readonly Profile[],
  ): Promise<ProfileWithContainers[]> {
    const profiles: ProfileWithContainers[] = [];
    for (const member of created) {
      this.publishChanged(await this.containers.withContainers(member));
      await this.startMember(member);
      const latest = (await this.repo.findByName(member.name)) ?? member;
      profiles.push(await this.containers.withContainers(latest));
    }
    return profiles;
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
    const version = await this.versions.findById(canonical.stack_version_id);
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
      srt_passphrase: canonical.srt_passphrase,
      stack_version_id: canonical.stack_version_id,
      max_slot: maxSlotOf(version?.contract),
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
      `[ProfileService] Added ${created.length} member(s) to group ${group.name} (size now ${refreshed.size}); deploying`,
    );

    return { group: refreshed, profiles: await this.deployNewMembers(created) };
  }
}
