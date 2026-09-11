export class DockerBeeAcquisitionError extends Error {
  constructor() {
    super('The private Bee connection could not be acquired. Verify the deployment target before trying again.');
    this.name = 'DockerBeeAcquisitionError';
  }
}
