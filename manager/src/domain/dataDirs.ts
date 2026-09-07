import { join } from 'node:path';

import {
  type EngineName,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

/**
 * Where a deployment's state lives on the host: one directory per profile
 * under the data root, bind-mounted into the api container at the same
 * absolute path, which is what lets both the compose files and the manager
 * name the same files. It survives a manager deploy, which rsyncs only the
 * checkout, and goes when the deployment is removed.
 */
export const BEE_DATA_ROOT =
  process.env.BEE_DATA_ROOT ?? '/home/solarpunk/streaming-infra-manager-data';

export function profileDataRoot(profileName: string): string {
  return join(BEE_DATA_ROOT, profileName);
}

export function beeDataDirsFor(profileName: string): Record<string, string> {
  return {
    BEE_UPLOADER_DATA_DIR: `${BEE_DATA_ROOT}/${profileName}/bee-uploader`,
    BEE_GATEWAY_DATA_DIR: `${BEE_DATA_ROOT}/${profileName}/bee-gateway`,
  };
}

/** The deployment's own engine config, and the scratch copies a check writes. */
export function engineConfigDirFor(profileName: string): string {
  return join(profileDataRoot(profileName), 'engine');
}

const ENGINE_CONFIG_FILE_NAMES: Record<EngineName, string> = {
  [SRS_SERVICE]: 'srs.conf',
  [OME_SERVICE]: 'Server.xml',
};

/** The file the compose override mounts into the engine container. */
export function engineConfigPathFor(
  profileName: string,
  engine: EngineName,
): string {
  return join(engineConfigDirFor(profileName), ENGINE_CONFIG_FILE_NAMES[engine]);
}
