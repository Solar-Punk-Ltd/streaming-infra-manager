import type { BeeBridgeCheck, ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { TransferRefusalError } from './TransferRefusalError.js';

export class DockerBeeAcquisitionError extends TransferRefusalError {
  constructor(cause: ChequebookRefusalCause = 'docker_unreachable', check: BeeBridgeCheck | null = null) {
    super('The private Bee connection could not be acquired. Verify the deployment target before trying again.', cause, check);
    this.name = 'DockerBeeAcquisitionError';
  }

  /** A fresh error that keeps the cause a caught manager error carried, so the caught error goes no further. */
  static keeping(error: unknown, fallback: ChequebookRefusalCause = 'docker_unreachable'): DockerBeeAcquisitionError {
    const carried = TransferRefusalError.carried(error);
    return carried ? new DockerBeeAcquisitionError(carried.cause, carried.check) : new DockerBeeAcquisitionError(fallback);
  }
}
