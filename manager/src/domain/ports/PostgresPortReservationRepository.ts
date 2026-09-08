import { Pool } from 'pg';

import { PortReservedError } from '../errors/index.js';
import { PROFILE_SLOT_LOCK_KEY } from '../profileSql.js';
import type { PortReservationRepository } from './PortReservationRepository.js';
import { type PortKey, type PortPlanEntry, type PortReconciliation, type PortReservation, type ReservationState, ownersAfterHandover, portKeyOf } from './portReservations.js';
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
      for (const row of held.rows) {
        const owners = [...new Set([...row.held_services, ...entries.filter(entry => portKeyOf(entry) === portKeyOf(row)).map(entry => entry.service)])];
        await client.query('UPDATE port_reservations SET held_services = $2::text[], updated_at = NOW() WHERE id = $1', [row.id, owners]);
      }
      const missing = entries.filter((entry) => !mine.has(portKeyOf(entry)));
      const inserted = await client.query<ReservationRow>(
        `INSERT INTO port_reservations (daemon_id, profile_name, protocol, port, port_var, service, held_services, state, reason)
         SELECT $1, $2, t.protocol, t.port, t.port_var, t.service, ARRAY[t.service], 'planned', $7
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

  async reconcile(observation: PortReconciliation): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
      const profile = await client.query<{ status: string }>('SELECT status FROM profiles WHERE name = $1 FOR UPDATE', [observation.profileName]);
      if (profile.rows[0]?.status !== 'DEPLOYING') {
        await client.query('COMMIT');
        return;
      }
      const rows = await client.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS} FROM port_reservations WHERE profile_name = $1 AND daemon_id = $2`,
        [observation.profileName, observation.daemonId],
      );
      const bound = new Set(observation.bound.map(portKeyOf));
      const planned = new Set(observation.planned.map(portKeyOf));
      const active = rows.rows.filter(row => bound.has(portKeyOf(row))).map(row => row.id);
      await client.query("UPDATE port_reservations SET state = 'active', updated_at = NOW() WHERE id = ANY($1::int[])", [active]);
      // Operation references do not yet carry a profile owner. Any open rollback hold conservatively blocks release.
      const blocked = await client.query<{ held: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM build_references WHERE resolved_at IS NULL
           AND ((holder_kind = 'job' AND holder_id = $1) OR holder_kind = 'operation'))
         OR EXISTS (SELECT 1 FROM deploy_attempts WHERE project = $1 AND state <> 'released') AS held`,
        [observation.profileName],
      );
      if (!blocked.rows[0]?.held) {
        for (const row of rows.rows) {
          const current = observation.planned.filter(entry => portKeyOf(entry) === portKeyOf(row));
          if (!current.length) continue;
          const owners = ownersAfterHandover(row.held_services, current.map(entry => entry.service), observation.services);
          const confirmed = current.find(entry => entry.service !== null && observation.services.includes(entry.service));
          await client.query('UPDATE port_reservations SET held_services = $2::text[], service = $3, updated_at = NOW() WHERE id = $1',
            [row.id, owners, confirmed?.service ?? row.service]);
        }
        const releasing = rows.rows.filter(row => row.held_services.length > 0 && row.held_services.every(service => service !== null && observation.services.includes(service))
          && !bound.has(portKeyOf(row)) && !planned.has(portKeyOf(row))).map(row => row.id);
        await client.query("UPDATE port_reservations SET state = 'releasing', updated_at = NOW() WHERE id = ANY($1::int[])", [releasing]);
        await client.query("DELETE FROM port_reservations WHERE id = ANY($1::int[]) AND state = 'releasing'", [releasing]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  async hasRemovalHold(profileName: string): Promise<boolean> {
    const result = await this.pool.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM deploy_attempts WHERE project = $1 AND state <> 'released')
        OR EXISTS (SELECT 1 FROM build_references WHERE holder_kind = 'operation' AND resolved_at IS NULL) AS held`, [profileName],
    );
    return result.rows[0]?.held ?? true;
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
