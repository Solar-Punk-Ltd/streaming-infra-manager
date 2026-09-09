import { BundledPublicationCommand, type BundledPublicationRequest } from '../domain/versions/BundledPublicationCommand.js';
import type { BundledActivation } from '../domain/versions/BundledShipment.js';
import type { BundledShipmentIdentity } from '../domain/versions/bundledShipmentPackage.js';
import { Database } from '../domain/Database.js';
import type { ManagerPublication } from '../domain/versions/ManagerUpgrade.js';
import { PostgresBundledShipmentRepository } from '../domain/versions/PostgresBundledShipmentRepository.js';
import { readManagerPublication } from '../domain/versions/readManagerPublication.js';
import { bundledPackageClaimsRootFor, configRootFor } from '../domain/versions/stackPaths.js';

const BUNDLED_VERSION_NAME = 'bundled';

/**
 * The database side of a manager upgrade, kept behind an interface so the
 * Compose adapter can be driven without one.
 */
export interface ManagerUpgradeDatabase {
  readPublication(identity: BundledShipmentIdentity): Promise<ManagerPublication>;
  migrate(): Promise<void>;
  publishBundled(request: BundledPublicationRequest): Promise<BundledActivation>;
  close(): Promise<void>;
}

export class PostgresManagerUpgradeDatabase implements ManagerUpgradeDatabase {
  private readonly database: Database;
  private readonly publication: BundledPublicationCommand;

  constructor(connectionString: string, versionsRoot: string) {
    this.database = new Database(connectionString);
    this.publication = new BundledPublicationCommand(
      new PostgresBundledShipmentRepository(this.database.pool, configRootFor(versionsRoot, BUNDLED_VERSION_NAME)),
      bundledPackageClaimsRootFor(versionsRoot),
    );
  }

  readPublication(identity: BundledShipmentIdentity): Promise<ManagerPublication> {
    return readManagerPublication(this.database.pool, identity);
  }

  migrate(): Promise<void> {
    return this.database.migrate();
  }

  publishBundled(request: BundledPublicationRequest): Promise<BundledActivation> {
    return this.publication.publish(request);
  }

  close(): Promise<void> {
    return this.database.close();
  }
}
