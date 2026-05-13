import { Profile, ProfileKind, TRANSITIONAL_STATUSES } from '../types.js';
import { ensureProfileEnv } from '../utils/repo.js';

import {
  DeploymentOrchestrator,
  ProfileBusyError,
} from './DeploymentOrchestrator.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';

const logger = Logger.getInstance();

/** Domain errors so the API layer can map to HTTP status codes cleanly. */
export class ProfileExistsError extends Error {
  constructor(public readonly name: string) {
    super(`Profile already exists: ${name}`);
    this.name = 'ProfileExistsError';
  }
}

export class AllSlotsUsedError extends Error {
  constructor() {
    super(
      'All port slots 1-999 are already allocated. Delete a profile to free one.',
    );
    this.name = 'AllSlotsUsedError';
  }
}

export class ProfileNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Profile not found: ${name}`);
    this.name = 'ProfileNotFoundError';
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

export class ProfileService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly orchestrator: DeploymentOrchestrator,
  ) {}

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
    stamp_id?: string;
  }): Promise<Profile> {
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
            feed_owner: input.feed_owner ?? null,
            feed_topic: input.feed_topic ?? null,
            private_key: input.private_key ?? null,
            stamp_id: input.stamp_id ?? null,
          },
        );

        try {
          ensureProfileEnv(input.name);
        } catch (err) {
          await this.repo.deleteByName(input.name);
          throw err;
        }

        logger.info(
          `[ProfileService] Created profile ${input.name} (kind=${input.kind}, slot=${slot})`,
        );

        try {
          await this.orchestrator.startInitialDeploy(row, input.components, {
            host: input.host,
          });
        } catch (err) {
          await this.repo.markError(
            input.name,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }

        return row;
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

  async list(): Promise<Profile[]> {
    return this.repo.list();
  }

  async getByName(name: string): Promise<Profile> {
    const row = await this.repo.findByName(name);
    if (!row) throw new ProfileNotFoundError(name);
    return row;
  }

  async remove(
    name: string,
    input: { volumes?: boolean; all?: boolean } = {},
  ): Promise<Profile> {
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
