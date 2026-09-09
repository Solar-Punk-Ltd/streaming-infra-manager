import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isGeneratedSettingKey,
  isSecretSettingKey,
  type StackSettings,
  type StackSettingsEntry,
  type StackSettingsFile,
} from '@streaming-infra-manager/common';

import { StackSettingsNotReadyError } from '../errors/StackSettingsNotReadyError.js';

import { readBuildManifest } from './buildManifest.js';
import { envAssignmentsOf, sampleSettingsOf } from './envSettingsText.js';
import {
  DEPLOY_CONFIG,
  DEPLOY_CONFIG_SAMPLE,
  holdHostConfigLock,
  hostConfigFilesOf,
  hostConfigNonFilesOf,
  readHostConfigRevision,
} from './hostConfigCapture.js';

/**
 * A version's settings as one page reads them: the operator's own files, each
 * against the sample the version's current build ships.
 *
 * The values come from the config root, which is the host's, and the order,
 * the descriptions and the defaults come from the build, which is the
 * version's. Both are read under one hold of the edit lock, so the generation
 * the page is given belongs to the bytes it was given, and a save that names
 * that generation is refused once anything has moved.
 */

export interface HostConfigSettingsSources {
  configRoot: string;
  /** The build tree the samples come from, or null for a version with no build. */
  buildRoot: string | null;
  buildId: string | null;
  /** From the version's contract, so the page can say which keys the manager fills. */
  requiredSecrets: readonly string[];
  lockWaitMs?: number;
}

/** Why a version can have no settings: the files are seeded by its first build. */
export const SETTINGS_NEED_A_BUILD =
  'They are seeded from the stack samples by the first build of a version, and this one has none.';

/** Sources of a version that has settings: it has been built, so it has a tree. */
export interface ReadyHostConfigSettings extends HostConfigSettingsSources {
  buildRoot: string;
}

/**
 * The sources as they are once the version has settings at all, or the refusal
 * saying it has none. A version gets both its files and the samples that
 * describe them from its first build, so before that there is nothing to read,
 * save or apply.
 */
export function readySettingsSources(
  versionName: string,
  sources: HostConfigSettingsSources,
): ReadyHostConfigSettings {
  if (sources.buildRoot === null || !existsSync(sources.configRoot)) {
    throw new StackSettingsNotReadyError(versionName, SETTINGS_NEED_A_BUILD);
  }
  return { ...sources, buildRoot: sources.buildRoot };
}

/** The version's settings, or why it has none to show. */
export async function readHostConfigSettings(
  versionName: string,
  sources: HostConfigSettingsSources,
): Promise<StackSettings> {
  const { configRoot, buildRoot } = readySettingsSources(versionName, sources);

  const release = await holdHostConfigLock(configRoot, sources.lockWaitMs);
  try {
    const revision = await readHostConfigRevision(configRoot);
    if (!revision) throw new StackSettingsNotReadyError(versionName, SETTINGS_NEED_A_BUILD);

    const files: StackSettingsFile[] = [];
    for (const relative of hostConfigFilesOf(configRoot)) {
      files.push(await settingsFileOf(relative, sources, buildRoot));
    }
    return {
      generation: revision.generation,
      buildId: sources.buildId,
      buildGeneration: readBuildManifest(buildRoot).manifest?.inputGeneration ?? null,
      files,
      leftAlone: hostConfigNonFilesOf(configRoot),
    };
  } finally {
    await release();
  }
}

async function settingsFileOf(
  relative: string,
  sources: HostConfigSettingsSources,
  buildRoot: string,
): Promise<StackSettingsFile> {
  const text = await readFile(join(sources.configRoot, relative), 'utf8');
  if (relative === DEPLOY_CONFIG) {
    return {
      path: relative,
      kind: 'json',
      text,
      sampleText: await readSample(buildRoot, DEPLOY_CONFIG_SAMPLE),
    };
  }
  return {
    path: relative,
    kind: 'env',
    entries: entriesOf(text, await readSample(buildRoot, sampleOf(relative)), sources.requiredSecrets),
  };
}

/** The sample beside a live env file: `.env.sample`, `engines/<engine>/.env.sample`. */
function sampleOf(relative: string): string {
  return `${relative}.sample`;
}

async function readSample(buildRoot: string, relative: string): Promise<string | null> {
  const path = join(buildRoot, relative);
  return existsSync(path) ? readFile(path, 'utf8') : null;
}

/**
 * The sample's keys in the sample's order, then whatever else the host's own
 * file assigns. A key the version stopped shipping is still the operator's and
 * still shown, at the end, where it reads as the extra it is.
 */
function entriesOf(
  text: string,
  sampleText: string | null,
  requiredSecrets: readonly string[],
): StackSettingsEntry[] {
  const assigned = envAssignmentsOf(text);
  const entries: StackSettingsEntry[] = [];
  const placed = new Set<string>();

  for (const setting of sampleSettingsOf(sampleText ?? '')) {
    placed.add(setting.key);
    entries.push(
      entryOf(setting.key, assigned.get(setting.key) ?? '', setting.value, setting.description, requiredSecrets),
    );
  }
  for (const [key, value] of assigned) {
    if (placed.has(key)) continue;
    entries.push(entryOf(key, value, null, '', requiredSecrets));
  }
  return entries;
}

function entryOf(
  key: string,
  value: string,
  sampleValue: string | null,
  description: string,
  requiredSecrets: readonly string[],
): StackSettingsEntry {
  return {
    key,
    value,
    sampleValue,
    description,
    secret: isSecretSettingKey(key),
    generated: isGeneratedSettingKey(key, requiredSecrets),
  };
}
