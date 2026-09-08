import type { PortProtocol, StackPortVar } from '@streaming-infra-manager/common';

import { portFor } from '../versions/portTable.js';

/**
 * A port reservation is a physical thing: one transport, one port number,
 * one daemon, held by one deployment for one of its services.
 *
 * `planned` is what admission wrote for a slot or a deploy not yet seen
 * bound, `active` is what inspection found a container bound to, and
 * `releasing` is what inspection found unbound after the deployment's plan
 * stopped naming it. A reservation is deleted only when no plan needs it,
 * and a stopped deployment keeps its reservations, because it may start
 * again on the same ports.
 */
export type ReservationState = 'planned' | 'active' | 'releasing';

export const RESERVATION_STATES: readonly ReservationState[] = ['planned', 'active', 'releasing'];

/** What a daemon owns once: the transport and the port number. */
export interface PortKey {
  protocol: PortProtocol;
  port: number;
}

/** One port a deployment binds for its slot, and why. */
export interface PortPlanEntry extends PortKey {
  /** The port variable of the version's table it comes from. */
  portVar: string;
  /** The compose service that publishes it, or null when the version's file maps none. */
  service: string | null;
}

export interface PortReservation extends PortPlanEntry {
  heldServices: readonly (string | null)[];
  id: number;
  daemonId: string;
  profileName: string;
  state: ReservationState;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortReconciliation {
  profileName: string;
  daemonId: string;
  services: readonly string[];
  planned: readonly PortPlanEntry[];
  bound: readonly PortKey[];
}

/** An untouched or unknown owner keeps its claim even when another service has moved onto the same port. */
export function ownersAfterHandover(
  previous: readonly (string | null)[], current: readonly (string | null)[], replaced: readonly string[],
): (string | null)[] {
  return [...new Set([...previous.filter(service => service === null || !replaced.includes(service)), ...current])];
}

/** The ports a deployment binds for a slot: the version's table shifted by ten per slot. */
export function portPlanFor(table: readonly StackPortVar[], slot: number): PortPlanEntry[] {
  return table.map((port) => ({
    protocol: port.protocol,
    port: portFor(port, slot),
    portVar: port.name,
    service: port.service,
  }));
}

/** `udp/10031`: the name of the pair a daemon owns once. */
export function portKeyOf(entry: PortKey): string {
  return `${entry.protocol}/${entry.port}`;
}
