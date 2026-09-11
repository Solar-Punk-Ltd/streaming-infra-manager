import { isDeepStrictEqual } from 'node:util';
import { BUNDLED_VERSION_NAME } from '@streaming-infra-manager/common';
import { BundledVersionError, DefaultVersionError, StackBuildBusyError } from '../errors/index.js';
import { StackVersionRemovalHeldError } from '../errors/StackVersionRemovalHeldError.js';
import type { StackVersionRecord } from './StackVersionRepository.js';

export function assertVersionRemovable(expected: StackVersionRecord, current: StackVersionRecord): void {
  const descriptor = (version: StackVersionRecord) => ({
    id: version.id, name: version.name, gitRef: version.gitRef, rootPath: version.rootPath,
    layout: version.layout, buildId: version.buildId, previousBuildId: version.previousBuildId,
    commitSha: version.commitSha, contract: version.contract,
  });
  if (!isDeepStrictEqual(descriptor(expected), descriptor(current))) throw new StackVersionRemovalHeldError(current.name, 'changed');
  if (current.name === BUNDLED_VERSION_NAME) throw new BundledVersionError('The bundled version comes with the manager and cannot be removed. Set another version as the default instead.');
  if (current.isDefault) throw new DefaultVersionError(current.name);
  if (current.status === 'building') throw new StackBuildBusyError(current.name);
}
