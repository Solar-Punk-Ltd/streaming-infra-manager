/** Apply asked of a deployment that runs no containers, whose Start uses its settings anyway. */
export class DeploymentStoppedError extends Error {
  constructor(readonly profileName: string) {
    super('This deployment is stopped, so there is nothing to apply the settings to. Start deploys it with them.');
    this.name = 'DeploymentStoppedError';
  }
}
