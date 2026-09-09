import type { StackContract } from '@streaming-infra-manager/common';
import type { BuildReference } from '../versions/buildReferences.js';
import type { StackVersionRecord } from '../versions/StackVersionRepository.js';
import type { PortPlanEntry, PortReservation } from './portReservations.js';
import type { PublishedPortBinding } from './PublishedPortsProbe.js';

export interface FirewallProfile {
  name: string;
  slot: number;
  status: string;
  target: string;
  versionId: number;
}

export type FirewallVersion = Pick<StackVersionRecord, 'id' | 'name' | 'layout' | 'rootPath' | 'buildId' | 'previousBuildId'>;
export type FirewallReference = Pick<BuildReference, 'versionId' | 'buildId' | 'holderKind' | 'holderId' | 'services'>;
export type FirewallReservation = Pick<PortReservation, 'daemonId' | 'profileName' | 'protocol' | 'port' | 'heldServices'>;
export type FirewallContract = Pick<StackContract, 'ports' | 'portAliases' | 'maxSlot' | 'allocationProblem'>;

/** Only structural facts. No profile keys, passwords, environment values or config contents. */
export interface FirewallState {
  inventoryReady: boolean;
  seededDaemons: string[];
  targets: { alias: string; daemonId: string | null; verified: boolean }[];
  profiles: FirewallProfile[];
  versions: FirewallVersion[];
  references: FirewallReference[];
  reservations: FirewallReservation[];
  attempts: { project: string; daemonId: string }[];
}

export interface FirewallStateSource { read(): Promise<FirewallState> }
export interface FirewallContractReader { read(version: FirewallVersion, buildId: string): Promise<FirewallContract> }

export interface FirewallClaim extends PortPlanEntry {
  profileName: string;
  versionId: number;
  buildId: string;
}

export interface FirewallInventory {
  schemaVersion: 1;
  policyVersion: number;
  daemonId: string;
  capturedAt: string;
  fingerprint: string;
  profiles: FirewallProfile[];
  claims: FirewallClaim[];
  reservations: FirewallReservation[];
  bindings: readonly PublishedPortBinding[];
}
