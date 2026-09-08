import type { PortKey } from './portReservations.js';

export interface PublishedPortBinding extends PortKey {
  project: string | null;
  service: string | null;
  containerId?: string;
}

export interface PublishedPortsSnapshot {
  daemonId: string;
  bindings: readonly PublishedPortBinding[];
  /** Running host-network containers have no published-port map, so absence cannot release their ports. */
  unverifiedProjects?: readonly string[];
}

export interface PublishedPortsProbe {
  publishedPorts(target: string): Promise<PublishedPortsSnapshot>;
}
