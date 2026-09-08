export class ReservationInventoryPendingError extends Error {
  constructor() {
    super('The reservation inventory is still being built. Wait until existing deployments have been accounted for before allocating ports.');
    this.name = 'ReservationInventoryPendingError';
  }
}
