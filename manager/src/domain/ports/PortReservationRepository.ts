import type { PortKey, PortPlanEntry, PortReconciliation, PortReservation, ReservationState } from './portReservations.js';

/**
 * The reservation table, apart from the allocation that writes it inside a
 * deployment's own insert transaction, which lives with the profile and
 * group repositories and shares its SQL through `reservationSql`.
 */
export interface PortReservationRepository {
  listByDaemon(daemonId: string): Promise<PortReservation[]>;
  listByProfile(profileName: string): Promise<PortReservation[]>;
  /** The rows of other deployments holding any of the entries on the daemon. */
  holdersOf(daemonId: string, entries: readonly PortKey[], except: string | null): Promise<PortReservation[]>;
  /**
   * Planned rows for the deployment, one per entry it does not hold yet.
   * Throws when another deployment holds one, naming it.
   */
  plan(daemonId: string, profileName: string, entries: readonly PortPlanEntry[], reason: string): Promise<PortReservation[]>;
  setState(ids: readonly number[], state: ReservationState): Promise<void>;
  /** Apply an observed handover under the allocation lock, retaining unresolved jobs and rollback holds. */
  reconcile(observation: PortReconciliation): Promise<void>;
  remove(ids: readonly number[]): Promise<void>;
  /** Every row of the deployment, for a removal. Answers how many went. */
  removeByProfile(profileName: string): Promise<number>;
  /** When the one-time seeding of existing deployments' reservations completed, or null. */
  inventorySeededAt(daemonId?: string): Promise<Date | null>;
  markInventorySeeded(daemonId?: string): Promise<void>;
}
