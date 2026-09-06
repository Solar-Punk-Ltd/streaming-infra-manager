import { containerNotRunningMessage } from '@streaming-infra-manager/common';

/**
 * Asked about a container that docker has no running instance of.
 *
 * Separate from ProfileNotFoundError: the deployment exists and the manager
 * knows all about it, the container just is not up. That is an ordinary state
 * after a stop or a failed deploy, so the message says what brings it back
 * rather than reading as a fault. The words come from common because the UI
 * tells this failure apart from the others by reading them.
 */
export class ContainerNotRunningError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly service: string,
  ) {
    super(containerNotRunningMessage(profileName, service));
    this.name = 'ContainerNotRunningError';
  }
}
