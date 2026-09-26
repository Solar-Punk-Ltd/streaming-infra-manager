/** A save of the manager's own settings made against a revision another save has since moved past. */
export class ManagerSettingsChangedError extends Error {
  constructor() {
    super("The manager's settings changed after the page read them. Reload them and make the change again.");
    this.name = 'ManagerSettingsChangedError';
  }
}
