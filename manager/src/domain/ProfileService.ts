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

  /**
   * Allocate slot + persist row in DEPLOYING + seed env file + spawn
   * deploy.sh. Returns the freshly-inserted row immediately; the caller
   * polls GET /profiles/:name to watch the status flip to RUNNING/ERROR.
   */
  async create(input: {
    name: string;
    kind: ProfileKind;
    notes?: string | null;
    components?: string[];
    host?: string;
    feed_owner?: string;
    feed_topic?: string;
    private_key?: string;
    public_key?: string;
    stamp_id?: string;
  }): Promise<ProfileWithContainers> {
    const existing = await this.repo.findByName(input.name);
    if (existing) throw new ProfileExistsError(input.name);

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const slot = await this.pickFreeSlot();
      try {
        const row = await this.repo.insert(
          input.name,
          slot,
          input.kind,
          input.notes ?? null,
          'DEPLOYING',
          {
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
          },
        );

        logger.info(
          `[ProfileService] Created profile ${input.name} (kind=${input.kind}, slot=${slot})`,
        );
        const withContainers = await this.containers.withContainers(row);
        this.publishChanged(withContainers);

        try {
          await this.orchestrator.startInitialDeploy(row, input.components, {
            host: input.host,
          });
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
      } catch (err) {
        const pgErr = err as PgError;
        if (pgErr.code === '23505' && pgErr.constraint !== 'profiles_pkey') {
          // Unique violation on port_slot — concurrent allocation. Retry.
          logger.warn(`[ProfileService] Slot ${slot} race; retrying`);
          continue;
        }
        if (pgErr.code === '23505' && pgErr.constraint === 'profiles_pkey') {
          throw new ProfileExistsError(input.name);
        }
        throw err;
      }
    }
    throw new AllSlotsUsedError();
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
      feed_owner?: string;
      feed_topic?: string;
      private_key?: string;
      public_key?: string;
      stamp_id?: string;
    },
  ): Promise<ProfileWithContainers> {
    const existing = await this.getByName(name);
    if (
      (TRANSITIONAL_STATUSES as readonly string[]).includes(existing.status)
    ) {
      throw new ProfileBusyError(name, existing.status);
    }

    const row = await this.repo.updateEditable(
      name,
      existing.kind,
      input.notes ?? null,
      {
        components: existing.components,
        feed_owner: input.feed_owner ?? null,
        feed_topic: input.feed_topic ?? null,
        private_key: input.private_key ?? null,
        public_key: input.public_key ?? null,
        stamp_id: input.stamp_id ?? null,
      },
    );
    if (!row) throw new ProfileNotFoundError(name);

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
    return withContainers;
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

  private async pickFreeSlot(): Promise<number> {
    const used = new Set(await this.repo.getUsedSlotsInOrder());
    for (let i = 1; i <= 999; i++) {
      if (!used.has(i)) return i;
    }
    throw new AllSlotsUsedError();
  }
}
