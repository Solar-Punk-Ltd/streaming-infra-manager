import { createHash } from 'node:crypto';
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

const ENGINE_CONFIG_FILE_PARTS: Record<EngineName, { stem: string; ext: string }> = {
  [SRS_SERVICE]: { stem: 'srs', ext: 'conf' },
  [OME_SERVICE]: { stem: 'Server', ext: 'xml' },
};

const CONTENT_TAG_LENGTH = 12;

function contentTag(config: string): string {
  return createHash('sha256').update(config, 'utf8').digest('hex').slice(0, CONTENT_TAG_LENGTH);
}

/**
 * The name the file is written under: `srs.<tag>.conf`, the tag being a hash
 * of the content.
 *
 * The content is in the name because compose recreates a container only when
 * its spec changes, and a bind mount's spec is its source path, not what is
 * in the file. A file rewritten in place under one fixed name left the
 * container running on the old text while the manager reported the new one
 * applied, measured on the host on 2026-09-07. A new name is a new mount and
 * a recreate, exactly as the first apply was.
 */
export function engineConfigFileName(engine: EngineName, config: string): string {
  const { stem, ext } = ENGINE_CONFIG_FILE_PARTS[engine];
  return `${stem}.${contentTag(config)}.${ext}`;
}

/**
 * Whether a name in the engine directory is one of this engine's config files,
 * current or stale. The plain `srs.conf` is the name the first build of this
 * used, before the tag; a directory under one of these names is what Docker
 * leaves when it restarts a container whose bind-mounted file is gone.
 */
export function isEngineConfigFile(engine: EngineName, name: string): boolean {
  const { stem, ext } = ENGINE_CONFIG_FILE_PARTS[engine];
  return new RegExp(
    `^${stem}\\.(?:[0-9a-f]{${CONTENT_TAG_LENGTH}}\\.)?${ext}$`,
  ).test(name);
}

/** The file the compose override mounts into the engine container. */
export function engineConfigPathFor(
  profileName: string,
  engine: EngineName,
  config: string,
): string {
  return join(engineConfigDirFor(profileName), engineConfigFileName(engine, config));
}
