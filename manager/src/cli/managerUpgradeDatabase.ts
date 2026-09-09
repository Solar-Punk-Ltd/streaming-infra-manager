import { BundledPublicationCommand, type BundledPublicationRequest } from '../domain/versions/BundledPublicationCommand.js';
import type { BundledShipmentJournal } from '../domain/versions/bundledPackageSweep.js';
import type { BundledActivation, BundledShipmentRecord } from '../domain/versions/BundledShipment.js';
import type { BundledShipmentIdentity } from '../domain/versions/bundledShipmentPackage.js';
import { Database } from '../domain/Database.js';
import type { ManagerPublication } from '../domain/versions/ManagerUpgrade.js';
import { PostgresBundledShipmentRepository } from '../domain/versions/PostgresBundledShipmentRepository.js';
import { readManagerPublication } from '../domain/versions/readManagerPublication.js';
import { bundledPackageClaimsRootFor, configRootFor } from '../domain/versions/stackPaths.js';

const BUNDLED_VERSION_NAME = 'bundled';

/**
 * The database side of a manager upgrade, kept behind an interface so the
 * Compose adapter can be driven without one. It answers the journal questions
 * of `BundledShipmentJournal` too, because the sweep that follows a
 * publication asks them of the same connection.
 */
export interface ManagerUpgradeDatabase extends BundledShipmentJournal {
  readPublication(identity: BundledShipmentIdentity): Promise<ManagerPublication>;
  migrate(): Promise<void>;
  publishBundled(request: BundledPublicationRequest): Promise<BundledActivation>;
  supersedeStalePending(versionId: number): Promise<BundledShipmentRecord[]>;
  close(): Promise<void>;
}

export class PostgresManagerUpgradeDatabase implements ManagerUpgradeDatabase {
  private readonly database: Database;
  private readonly shipments: PostgresBundledShipmentRepository;
  private readonly publication: BundledPublicationCommand;

  constructor(connectionString: string, versionsRoot: string) {
    this.database = new Database(connectionString);
    this.shipments = new PostgresBundledShipmentRepository(this.database.pool, configRootFor(versionsRoot, BUNDLED_VERSION_NAME));
    this.publication = new BundledPublicationCommand(this.shipments, bundledPackageClaimsRootFor(versionsRoot));
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

  supersedeStalePending(versionId: number): Promise<BundledShipmentRecord[]> {
    return this.shipments.supersedeStalePending(versionId);
  }

  find(shipmentId: string): Promise<BundledShipmentRecord | null> {
    return this.shipments.find(shipmentId);
  }

  findByMaterialization(materializationId: string): Promise<BundledShipmentRecord | null> {
    return this.shipments.findByMaterialization(materializationId);
  }

  close(): Promise<void> {
    return this.database.close();
  }
}
