/** A save of a deployment's settings made against a revision another save has since moved past. */
export class DeploymentSettingsChangedError extends Error {
  constructor(readonly profileName: string) {
    super("This deployment's settings changed after the page read them. Reload them and make the change again.");
    this.name = 'DeploymentSettingsChangedError';
  }
}
