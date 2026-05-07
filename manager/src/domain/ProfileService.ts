import { deleteProfileEnv, ensureProfileEnv } from '../utils/repo.js';
import { Profile, ProfileKind } from '../types.js';

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

export class AllPrefixesUsedError extends Error {
  constructor() {
    super(
      'All port prefixes 1-9 are already allocated. Delete a profile to free one.',
    );
    this.name = 'AllPrefixesUsedError';
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

/**
 * Orchestrates profile lifecycle: picks a free port_prefix, persists the row,
 * and creates the per-profile env file the deploy script needs.
 *
 * Race-safe: the unique-prefix constraint catches concurrent allocations and
 * the loser retries with a freshly-picked prefix.
 */
export class ProfileService {
  constructor(private readonly repo: ProfileRepository) {}

  async create(input: {
    name: string;
    kind: ProfileKind;
    notes?: string | null;
  }): Promise<Profile> {
    const existing = await this.repo.findByName(input.name);
    if (existing) throw new ProfileExistsError(input.name);

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const prefix = await this.pickFreePrefix();
      try {
        const row = await this.repo.insert(
          input.name,
          prefix,
          input.kind,
          input.notes ?? null,
        );

        // Seed the env file so deploy.sh's require_env passes. Roll back the
        // DB row if seeding fails — keeps state consistent.
        try {
          ensureProfileEnv(input.name);
        } catch (err) {
          await this.repo.deleteByName(input.name);
          throw err;
        }

        logger.info(
          `[ProfileService] Created profile ${input.name} (kind=${input.kind}, prefix=${prefix})`,
        );
        return row;
      } catch (err) {
        const pgErr = err as PgError;
        if (pgErr.code === '23505' && pgErr.constraint !== 'profiles_pkey') {
          // Unique violation on port_prefix — concurrent allocation. Retry.
          logger.warn(`[ProfileService] Prefix ${prefix} race; retrying`);
          continue;
        }
        if (pgErr.code === '23505' && pgErr.constraint === 'profiles_pkey') {
          throw new ProfileExistsError(input.name);
        }
        throw err;
      }
    }
    throw new AllPrefixesUsedError();
  }

  async list(): Promise<Profile[]> {
    return this.repo.list();
  }

  async getByName(name: string): Promise<Profile> {
    const row = await this.repo.findByName(name);
    if (!row) throw new ProfileNotFoundError(name);
    return row;
  }

  async delete(name: string): Promise<{ released_prefix: number }> {
    const released = await this.repo.deleteByName(name);
    if (!released) throw new ProfileNotFoundError(name);
    deleteProfileEnv(name);
    logger.info(
      `[ProfileService] Deleted profile ${name} (released prefix ${released.port_prefix})`,
    );
    return { released_prefix: released.port_prefix };
  }

  private async pickFreePrefix(): Promise<number> {
    const used = new Set(await this.repo.getUsedPortsInOrder());
    for (let i = 1; i <= 9; i++) {
      if (!used.has(i)) return i;
    }
    throw new AllPrefixesUsedError();
  }
}
