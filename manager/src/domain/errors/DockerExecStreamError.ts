export class DockerExecStreamError extends Error {
  constructor() {
    super('The private Docker byte stream could not be used.');
    this.name = 'DockerExecStreamError';
  }
}
