import type { PortReservation } from '../ports/portReservations.js';

/** A port a deployment needs is held by another deployment on the same daemon. */
export class PortReservedError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly holder: PortReservation,
  ) {
    super(
      `${profileName} needs ${holder.protocol} port ${holder.port}, which ${holder.profileName} holds${holder.service ? ` for ${holder.service}` : ''} (${holder.state}).`,
    );
    this.name = 'PortReservedError';
  }
}
