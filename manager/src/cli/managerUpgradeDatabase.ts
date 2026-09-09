import { BUNDLED_VERSION_NAME } from '@streaming-infra-manager/common';

import { Database } from '../domain/Database.js';
import type { ManagerPublication } from '../domain/versions/ManagerUpgrade.js';
import { PostgresStackVersionRepository } from '../domain/versions/PostgresStackVersionRepository.js';
import { readManagerPublication } from '../domain/versions/readManagerPublication.js';

/** What the upgrade watches while the api builds the commit the manager pins. */
export interface BundledVersionState {
  status: string;
  layout: string;
  gitRef: string;
  commitSha: string | null;
  buildId: string | null;
  lastError: string | null;
}

/**
 * The database side of a manager upgrade, kept behind an interface so the
 * Compose adapter can be driven without one.
 */
export interface ManagerUpgradeDatabase {
  readPublication(): Promise<ManagerPublication>;
  migrate(): Promise<void>;
  /** The bundled version row, or null on a database that holds none. */
  readBundledVersion(): Promise<BundledVersionState | null>;
  close(): Promise<void>;
}

export class PostgresManagerUpgradeDatabase implements ManagerUpgradeDatabase {
  private readonly database: Database;
  private readonly versions: PostgresStackVersionRepository;

  constructor(connectionString: string) {
    this.database = new Database(connectionString);
    this.versions = new PostgresStackVersionRepository(this.database.pool);
  }

  readPublication(): Promise<ManagerPublication> {
    return readManagerPublication(this.database.pool);
  }

  migrate(): Promise<void> {
    return this.database.migrate();
  }

  async readBundledVersion(): Promise<BundledVersionState | null> {
    return this.versions.findByName(BUNDLED_VERSION_NAME);
  }

  close(): Promise<void> {
    return this.database.close();
  }
}
