export class EngineSettingsChangedError extends Error {
  constructor(readonly profileName: string) {
    super('The deployment changed before these settings could be saved. Refresh and review before applying again.');
    this.name = 'EngineSettingsChangedError';
  }
}
