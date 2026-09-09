import { MANAGER_SLOT_CAP, PORT_SLOT_STRIDE, portExposureProblem, type StackPortVar } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';
import { PortReservedError } from '../errors/index.js';
import { PROFILE_SLOT_LOCK_KEY } from '../profileSql.js';

import { type PortPlanEntry, type PortReservation, type ReservationState, portKeyOf, portPlanFor } from './portReservations.js';

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

/** The caller owns the transaction and acquires the allocator lock before any profile or daemon locks. */
export async function planPortReservations(
  client: PoolClient,
  daemonId: string,
  profileName: string,
  entries: readonly PortPlanEntry[],
  reason: string,
): Promise<PortReservation[]> {
  const planned = structuredClone(entries);
  // The allocator takes this lock too. Row locks alone cannot protect a port with no row yet.
  await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
  const held = await client.query<ReservationRow>(
    `SELECT r.*
       FROM port_reservations r
       JOIN unnest($2::text[], $3::int[]) AS t(protocol, port) ON r.protocol = t.protocol AND r.port = t.port
      WHERE r.daemon_id = $1
      FOR UPDATE`,
    [daemonId, planned.map(entry => entry.protocol), planned.map(entry => entry.port)],
  );
  const other = held.rows.find(row => row.profile_name !== profileName);
  if (other) throw new PortReservedError(profileName, toReservation(other));
  const mine = new Set(held.rows.map(row => portKeyOf(row)));
  for (const row of held.rows) {
    const owners = [...new Set([...row.held_services, ...planned.filter(entry => portKeyOf(entry) === portKeyOf(row)).map(entry => entry.service)])];
    await client.query('UPDATE port_reservations SET held_services = $2::text[], updated_at = NOW() WHERE id = $1', [row.id, owners]);
  }
  const missing = planned.filter(entry => !mine.has(portKeyOf(entry)));
  const inserted = await client.query<ReservationRow>(
    `INSERT INTO port_reservations (daemon_id, profile_name, protocol, port, port_var, service, held_services, state, reason)
     SELECT $1, $2, t.protocol, t.port, t.port_var, t.service, ARRAY[t.service], 'planned', $7
       FROM unnest($3::text[], $4::int[], $5::text[], $6::text[]) AS t(protocol, port, port_var, service)
     RETURNING ${RESERVATION_COLUMNS}`,
    [daemonId, profileName, missing.map(entry => entry.protocol), missing.map(entry => entry.port),
      missing.map(entry => entry.portVar), missing.map(entry => entry.service), reason],
  );
  return inserted.rows.map(toReservation);
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
  const candidates = Array.from({ length: Math.min(placement.slotCap, MANAGER_SLOT_CAP) }, (_, index) => index + 1)
    .filter(slot => portPlanFor(placement.table, slot).every(entry => portExposureProblem(entry) === null));
  const result = await client.query<{ n: number }>(
    `SELECT s.n
       FROM unnest($1::int[]) AS s(n)
      WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.port_slot = s.n)
        AND NOT EXISTS (
          SELECT 1
            FROM port_reservations r
            JOIN unnest($2::text[], $3::int[]) AS t(protocol, base)
              ON r.protocol = t.protocol AND r.port = t.base + s.n * $5
           WHERE r.daemon_id = $4)
      ORDER BY s.n
      LIMIT 1`,
    [
      candidates,
      placement.table.map((port) => port.protocol),
      placement.table.map((port) => port.slotBase),
      placement.daemonId,
      PORT_SLOT_STRIDE,
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
