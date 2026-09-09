import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  StackSettingsFileEdit,
  StackSettingsSave,
} from '@streaming-infra-manager/common';

import { InvalidStackVersionError } from '../errors/InvalidStackVersionError.js';
import { StackSettingsChangedError } from '../errors/StackSettingsChangedError.js';
import { StackSettingsNotReadyError } from '../errors/StackSettingsNotReadyError.js';

import { rewriteEnvText, type EnvEdit } from './envSettingsText.js';
import {
  hostConfigFilesOf,
  hostConfigNonFilesOf,
  readHostConfigRevision,
  withHostConfigLock,
} from './hostConfigCapture.js';
import { SETTINGS_NEED_A_BUILD } from './hostConfigSettings.js';

/**
 * One save of a version's settings, as one revision.
 *
 * The whole save happens under one hold of the edit lock: the generation is
 * read, checked against the one the page loaded, and the files are written and
 * committed before the lock is let go. Without that a save would write back
 * bytes an editing session over ssh had already replaced, and the manifest
 * carries no expected generation of its own to catch it.
 *
 * Only the files the save names are written, and an env file is rewritten from
 * its own current bytes rather than rebuilt from the keys the page holds. The
 * comments in these files are the documentation of the host.
 */

const NOT_A_FILE_HERE =
  'This version keeps no settings file at that path. Reload the settings and save again.';

/** Nothing under a versions root is followed, so a link at one of these paths is passed by. */
const NOT_A_PLAIN_FILE =
  'There is a link or a directory at that path and nothing here reads it. Put a regular file there on the host, then reload the settings.';

/** Commits the save and answers the revision the files are at now. */
export async function saveHostConfigSettings(
  versionName: string,
  configRoot: string,
  save: StackSettingsSave,
  lockWaitMs?: number,
): Promise<number> {
  return withHostConfigLock(
    configRoot,
    async (commit) => {
      const revision = await readHostConfigRevision(configRoot);
      if (!revision) {
        throw new StackSettingsNotReadyError(versionName, SETTINGS_NEED_A_BUILD);
      }
      if (revision.generation !== save.expectedGeneration) {
        throw new StackSettingsChangedError(versionName, revision.generation);
      }

      const present = new Set(hostConfigFilesOf(configRoot));
      const leftAlone = new Set(hostConfigNonFilesOf(configRoot));
      const files: Record<string, Buffer> = {};
      for (const edit of save.files) {
        if (!present.has(edit.path)) {
          const why = leftAlone.has(edit.path) ? NOT_A_PLAIN_FILE : NOT_A_FILE_HERE;
          throw new InvalidStackVersionError(`${edit.path}: ${why}`);
        }
        files[edit.path] = await editedBytes(join(configRoot, edit.path), edit);
      }
      return (await commit(files)).generation;
    },
    lockWaitMs,
  );
}

async function editedBytes(path: string, edit: StackSettingsFileEdit): Promise<Buffer> {
  if ('text' in edit) return Buffer.from(edit.text, 'utf8');
  const current = await readFile(path, 'utf8');
  return Buffer.from(rewriteEnvText(current, edit.entries as readonly EnvEdit[]), 'utf8');
}

/** What a save touched, key names only. A value of these files never reaches a log. */
export function describeSettingsSave(save: StackSettingsSave): string {
  return save.files
    .map((file) =>
      'text' in file
        ? file.path
        : `${file.path} ${file.entries.map((entry) => entry.key).join(' ')}`,
    )
    .join(', ');
}
