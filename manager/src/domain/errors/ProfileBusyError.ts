import { ProfileStatus } from '../../types/index.js';

export class ProfileBusyError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly currentStatus: ProfileStatus,
  ) {
    super(`Profile ${profileName} is busy (status=${currentStatus})`);
    this.name = 'ProfileBusyError';
  }
}
