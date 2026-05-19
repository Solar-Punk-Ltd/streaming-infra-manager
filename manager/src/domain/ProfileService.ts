import { getErrorMessage } from '@streaming-infra-manager/common';

import {
  ProfileKind,
  ProfileWithContainers,
  TRANSITIONAL_STATUSES,
} from '../types/index.js';

import { ContainerRepository } from './ContainerRepository.js';
import { DeploymentOrchestrator } from './DeploymentOrchestrator.js';
import {
  AllSlotsUsedError,
  ProfileBusyError,
  ProfileExistsError,
  ProfileNotFoundError,
} from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';

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
        this.publishChanged(await this.containers.withContainers(errored));
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
    input: { volumes?: boolean; all?: boolean } = {},
  ): Promise<ProfileWithContainers> {
    const profile = await this.getByName(name);
    if ((TRANSITIONAL_STATUSES as readonly string[]).includes(profile.status)) {
      throw new ProfileBusyError(name, profile.status);
    }
    await this.orchestrator.startRemove(profile, input);
    return { ...profile, status: 'REMOVING' };
  }
}
