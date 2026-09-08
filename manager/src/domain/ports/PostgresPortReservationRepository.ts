import { Pool } from 'pg';

import { PortReservedError } from '../errors/index.js';
import { PROFILE_SLOT_LOCK_KEY } from '../profileSql.js';
import type { PortReservationRepository } from './PortReservationRepository.js';
import { type PortKey, type PortPlanEntry, type PortReservation, type ReservationState, portKeyOf } from './portReservations.js';
import { RESERVATION_COLUMNS, type ReservationRow, toReservation } from './reservationSql.js';

const INVENTORY_ROW = 1;

export class PostgresPortReservationRepository implements PortReservationRepository {
  constructor(private readonly pool: Pool) {}

  async listByDaemon(daemonId: string): Promise<PortReservation[]> {
    const result = await this.pool.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM port_reservations WHERE daemon_id = $1 ORDER BY protocol, port`,
      [daemonId],
    );
    return result.rows.map(toReservation);
  }

  async listByProfile(profileName: string): Promise<PortReservation[]> {
    const result = await this.pool.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM port_reservations WHERE profile_name = $1 ORDER BY protocol, port`,
      [profileName],
    );
    return result.rows.map(toReservation);
  }

  async holdersOf(daemonId: string, entries: readonly PortKey[], except: string | null): Promise<PortReservation[]> {
    if (entries.length === 0) return [];
    const result = await this.pool.query<ReservationRow>(
      `SELECT r.*
         FROM port_reservations r
         JOIN unnest($2::text[], $3::int[]) AS t(protocol, port) ON r.protocol = t.protocol AND r.port = t.port
        WHERE r.daemon_id = $1 AND ($4::text IS NULL OR r.profile_name <> $4)`,
      [daemonId, entries.map((entry) => entry.protocol), entries.map((entry) => entry.port), except],
    );
    return result.rows.map(toReservation);
  }

  async plan(daemonId: string, profileName: string, entries: readonly PortPlanEntry[], reason: string): Promise<PortReservation[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The allocator takes this lock too. Row locks alone cannot protect a port with no row yet.
      await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
      const held = await client.query<ReservationRow>(
        `SELECT r.*
           FROM port_reservations r
           JOIN unnest($2::text[], $3::int[]) AS t(protocol, port) ON r.protocol = t.protocol AND r.port = t.port
          WHERE r.daemon_id = $1
          FOR UPDATE`,
        [daemonId, entries.map((entry) => entry.protocol), entries.map((entry) => entry.port)],
      );
      const other = held.rows.find((row) => row.profile_name !== profileName);
      if (other) {
        await client.query('ROLLBACK');
        throw new PortReservedError(profileName, toReservation(other));
      }
      const mine = new Set(held.rows.map((row) => portKeyOf({ protocol: row.protocol, port: row.port })));
      const missing = entries.filter((entry) => !mine.has(portKeyOf(entry)));
      const inserted = await client.query<ReservationRow>(
        `INSERT INTO port_reservations (daemon_id, profile_name, protocol, port, port_var, service, state, reason)
         SELECT $1, $2, t.protocol, t.port, t.port_var, t.service, 'planned', $7
           FROM unnest($3::text[], $4::int[], $5::text[], $6::text[]) AS t(protocol, port, port_var, service)
         RETURNING ${RESERVATION_COLUMNS}`,
        [
          daemonId,
          profileName,
          missing.map((entry) => entry.protocol),
          missing.map((entry) => entry.port),
          missing.map((entry) => entry.portVar),
          missing.map((entry) => entry.service),
          reason,
        ],
      );
      await client.query('COMMIT');
      return inserted.rows.map(toReservation);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async setState(ids: readonly number[], state: ReservationState): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE port_reservations SET state = $2, updated_at = NOW() WHERE id = ANY($1::int[])`,
      [[...ids], state],
    );
  }

  async remove(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(`DELETE FROM port_reservations WHERE id = ANY($1::int[])`, [[...ids]]);
  }

  async removeByProfile(profileName: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM port_reservations WHERE profile_name = $1`, [profileName]);
    return result.rowCount ?? 0;
  }

  async inventorySeededAt(daemonId?: string): Promise<Date | null> {
    if (daemonId !== undefined) {
      const result = await this.pool.query<{ seeded_at: Date }>(
        'SELECT seeded_at FROM reservation_daemon_inventory WHERE daemon_id = $1', [daemonId],
      );
      return result.rows[0]?.seeded_at ?? null;
    }
    const result = await this.pool.query<{ seeded_at: Date | null }>(
      `SELECT seeded_at FROM reservation_inventory WHERE id = $1`,
      [INVENTORY_ROW],
    );
    return result.rows[0]?.seeded_at ?? null;
  }

  async markInventorySeeded(daemonId?: string): Promise<void> {
    if (daemonId !== undefined) {
      await this.pool.query(
        'INSERT INTO reservation_daemon_inventory (daemon_id) VALUES ($1) ON CONFLICT (daemon_id) DO NOTHING', [daemonId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE reservation_inventory SET seeded_at = COALESCE(seeded_at, NOW()) WHERE id = $1`,
      [INVENTORY_ROW],
    );
  }
}
