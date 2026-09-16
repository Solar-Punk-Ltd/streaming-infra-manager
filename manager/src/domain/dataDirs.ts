import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  type EngineName,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import { isLocalTarget } from './ports/DeployTargets.js';

/**
 * Where a deployment on the manager's own host keeps its state: one directory
 * per profile under the data root, bind-mounted into the api container at the
 * same absolute path, which is what lets both the compose files and the manager
 * name the same files. It survives a manager deploy, which rsyncs only the
 * checkout, and goes when the deployment is removed. A deployment on a remote
 * target gets no directory here at all, `beeDataDirsFor` below says why.
 */
export const BEE_DATA_ROOT =
  process.env.BEE_DATA_ROOT ?? '/home/solarpunk/streaming-infra-manager-data';

export function profileDataRoot(profileName: string): string {
  return join(BEE_DATA_ROOT, profileName);
}

/**
 * BEE_DATA_ROOT is a directory on the *manager's* host: somewhere it can size
 * (getProfileDiskUsage) and delete (removeProfileDataDir), outside the stack
 * checkout that `rsync --delete` rewrites on every deploy. None of that holds
 * for a remote target, and the value never reaches the remote compose either:
 * it is process env for deploy.sh here, and neither the rsynced .env nor
 * .env.deploy carries it.
 *
 * Exporting it anyway put deploy.sh and compose on different directories:
 * init_bee_dirs wrote the password under $REMOTE_BASE/deploy/<this absolute
 * path>, compose mounted $REMOTE_BASE/deploy/data/bee-uploader, and every
 * remote Bee node died on "configure signer: open /home/bee/.bee/password: no
 * such file or directory".
 *
 * So for a remote target, say nothing: the stack's own default
 * BEE_UPLOADER_DATA_DIR=./data/bee-uploader is rsynced to that host and is the
 * one value both deploy.sh and compose resolve against $REMOTE_BASE/deploy.
 *
 * "Local" is the one rule target verification already applies: the shared
 * `isLocalTarget`, mirroring the pinned stack's `is_local`, which is exactly
 * `target == "localhost"`. So a loopback spelling like `127.0.0.1` is not local
 * here either: to deploy.sh it is an ssh target like any other, compose on the
 * far side reads the rsynced .env, and an absolute manager path exported for it
 * recreates the very mismatch above. Extending what counts as local is a change
 * to LOCAL_TARGET_ALIASES, in one place, for the whole manager.
 */
export function beeDataDirsFor(
  profileName: string,
  target: string,
): Record<string, string> {
  if (!isLocalTarget(target)) return {};
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
 * used, before the tag. A directory under one of these names is what Docker
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
