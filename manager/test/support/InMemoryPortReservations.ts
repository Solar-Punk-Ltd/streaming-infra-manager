import type { StackPortVar } from '@streaming-infra-manager/common';

import { PortReservedError } from '../../src/domain/errors/index.js';
import type { PortReservationRepository } from '../../src/domain/ports/PortReservationRepository.js';
import {
  type PortKey,
  type PortPlanEntry,
  type PortReservation,
  type ReservationState,
  portKeyOf,
  portPlanFor,
} from '../../src/domain/ports/portReservations.js';

/**
 * The reservation table over an array, with the allocation rule the SQL
 * applies under its lock: `freeSlot` is what the profile and group fakes
 * ask before they insert a deployment.
 */
export class InMemoryPortReservations implements PortReservationRepository {
  readonly rows: PortReservation[] = [];

  seededAt: Date | null = null;

  private nextId = 1;

  private clock = 0;

  /** The lowest slot up to the cap no record holds and no port of which anyone holds on the daemon, or null. */
  freeSlot(daemonId: string, table: readonly StackPortVar[], slotCap: number, takenSlots: ReadonlySet<number>): number | null {
    for (let slot = 1; slot <= slotCap; slot += 1) {
      if (takenSlots.has(slot)) continue;
      const plan = portPlanFor(table, slot);
      if (plan.some((entry) => this.holderOf(daemonId, entry))) continue;
      return slot;
    }
    return null;
  }

  private holderOf(daemonId: string, key: PortKey): PortReservation | undefined {
    return this.rows.find((row) => row.daemonId === daemonId && portKeyOf(row) === portKeyOf(key));
  }

  async listByDaemon(daemonId: string): Promise<PortReservation[]> {
    return this.rows.filter((row) => row.daemonId === daemonId);
  }

  async listByProfile(profileName: string): Promise<PortReservation[]> {
    return this.rows.filter((row) => row.profileName === profileName);
  }

  async holdersOf(daemonId: string, entries: readonly PortKey[], except: string | null): Promise<PortReservation[]> {
    const wanted = new Set(entries.map(portKeyOf));
    return this.rows.filter(
      (row) => row.daemonId === daemonId && wanted.has(portKeyOf(row)) && row.profileName !== except,
    );
  }

  async plan(daemonId: string, profileName: string, entries: readonly PortPlanEntry[], reason: string): Promise<PortReservation[]> {
    for (const entry of entries) {
      const holder = this.holderOf(daemonId, entry);
      if (holder && holder.profileName !== profileName) throw new PortReservedError(profileName, holder);
    }
    const planned: PortReservation[] = [];
    for (const entry of entries) {
      if (this.holderOf(daemonId, entry)) continue;
      const row: PortReservation = {
        id: this.nextId++,
        daemonId,
        profileName,
        ...entry,
        state: 'planned',
        reason,
        createdAt: new Date(++this.clock),
        updatedAt: new Date(this.clock),
      };
      this.rows.push(row);
      planned.push(row);
    }
    return planned;
  }

  /** The synchronous plan the profile fakes use inside their own insert, the way the SQL does it in one transaction. */
  planNow(daemonId: string, profileName: string, entries: readonly PortPlanEntry[], reason: string): void {
    for (const entry of entries) {
      this.rows.push({
        id: this.nextId++,
        daemonId,
        profileName,
        ...entry,
        state: 'planned',
        reason,
        createdAt: new Date(++this.clock),
        updatedAt: new Date(this.clock),
      });
    }
  }

  async setState(ids: readonly number[], state: ReservationState): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id)) Object.assign(row, { state, updatedAt: new Date(++this.clock) });
    }
  }

  async remove(ids: readonly number[]): Promise<void> {
    this.drop((row) => ids.includes(row.id));
  }

  async removeByProfile(profileName: string): Promise<number> {
    return this.drop((row) => row.profileName === profileName);
  }

  /** Synchronous, for the fakes that undo a group's members. */
  dropProfile(profileName: string): void {
    this.drop((row) => row.profileName === profileName);
  }

  private drop(matches: (row: PortReservation) => boolean): number {
    let removed = 0;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (matches(this.rows[index]!)) {
        this.rows.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  async inventorySeededAt(): Promise<Date | null> {
    return this.seededAt;
  }

  async markInventorySeeded(): Promise<void> {
    this.seededAt ??= new Date(++this.clock);
  }
}
