import type { StackPortVar } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';

import { type PortPlanEntry, type PortReservation, type ReservationState, portPlanFor } from './portReservations.js';

export const RESERVATION_COLUMNS = `
  id, daemon_id, protocol, port, profile_name, service, held_services, port_var, state, reason, created_at, updated_at
`;

export interface ReservationRow {
  id: number;
  daemon_id: string;
  protocol: 'tcp' | 'udp';
  port: number;
  profile_name: string;
  service: string | null;
  held_services: (string | null)[];
  port_var: string;
  state: ReservationState;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toReservation(row: ReservationRow): PortReservation {
  return {
    id: row.id,
    daemonId: row.daemon_id,
    protocol: row.protocol,
    port: row.port,
    profileName: row.profile_name,
    service: row.service,
    heldServices: row.held_services,
    portVar: row.port_var,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Where a new deployment goes: its version's table, the cap, and the daemon its ports belong to. */
export interface SlotPlacement {
  slotCap: number;
  daemonId: string;
  table: readonly StackPortVar[];
}

/**
 * The lowest slot from 1 to the cap that no deployment record holds and no
 * port of which another deployment holds on the daemon, or null. Every
 * stored record counts, stopped ones included, because a stopped
 * deployment keeps its slot and its reservations. Run under the profile
 * slot lock, inside the transaction that inserts the deployment.
 */
export async function freeSlotFor(client: PoolClient, placement: SlotPlacement): Promise<number | null> {
  const result = await client.query<{ n: number }>(
    `SELECT s.n
       FROM generate_series(1, $1::int) AS s(n)
      WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.port_slot = s.n)
        AND NOT EXISTS (
          SELECT 1
            FROM port_reservations r
            JOIN unnest($2::text[], $3::int[]) AS t(protocol, base)
              ON r.protocol = t.protocol AND r.port = t.base + s.n * 10
           WHERE r.daemon_id = $4)
      ORDER BY s.n
      LIMIT 1`,
    [
      placement.slotCap,
      placement.table.map((port) => port.protocol),
      placement.table.map((port) => port.slotBase),
      placement.daemonId,
    ],
  );
  return result.rows[0]?.n ?? null;
}

/** The plan of a slot, reserved planned for the deployment, in the caller's transaction. */
export async function insertPlannedReservations(
  client: PoolClient,
  daemonId: string,
  profileName: string,
  entries: readonly PortPlanEntry[],
  reason: string,
): Promise<void> {
  if (entries.length === 0) return;
  await client.query(
    `INSERT INTO port_reservations (daemon_id, profile_name, protocol, port, port_var, service, held_services, state, reason)
     SELECT $1, $2, t.protocol, t.port, t.port_var, t.service, ARRAY[t.service], 'planned', $7
       FROM unnest($3::text[], $4::int[], $5::text[], $6::text[]) AS t(protocol, port, port_var, service)`,
    [
      daemonId,
      profileName,
      entries.map((entry) => entry.protocol),
      entries.map((entry) => entry.port),
      entries.map((entry) => entry.portVar),
      entries.map((entry) => entry.service),
      reason,
    ],
  );
}

/** Allocation in one step: the slot, and every port of it reserved for the deployment. */
export async function reserveSlotFor(
  client: PoolClient,
  profileName: string,
  placement: SlotPlacement,
): Promise<number | null> {
  const slot = await freeSlotFor(client, placement);
  if (slot === null) return null;
  await insertPlannedReservations(
    client,
    placement.daemonId,
    profileName,
    portPlanFor(placement.table, slot),
    `allocated with ${profileName}`,
  );
  return slot;
}
