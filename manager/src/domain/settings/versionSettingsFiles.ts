import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EngineName } from '@streaming-infra-manager/common';

import { baseEnvPath, engineEnvPath, parseEnvText } from '../../utils/envUtils.js';

import type { CatalogInput } from './deploymentSettingsCatalog.js';

const SAMPLE_FILE = '.env.sample';
const ENGINES_DIR = 'engines';

/** The four files of a build a settings list reads: the samples for the keys, the env files for the values. */
export type VersionSettingsFiles = Pick<CatalogInput, 'rootSampleText' | 'engineSampleText' | 'baseEnvText' | 'engineEnvText'>;

/** The settings files of the build at `root` for this engine. A file the build does not have reads as empty. */
export function versionSettingsFilesAt(root: string, engine: EngineName): VersionSettingsFiles {
  return {
    rootSampleText: readIfPresent(join(root, SAMPLE_FILE)),
    engineSampleText: readIfPresent(join(root, ENGINES_DIR, engine, SAMPLE_FILE)),
    baseEnvText: readIfPresent(baseEnvPath(root)),
    engineEnvText: readIfPresent(engineEnvPath(root, engine)),
  };
}

/** What the version sets: the engine's file, and the root file over it, the way the deploy script reads them. */
export function versionValuesOf(files: Pick<VersionSettingsFiles, 'baseEnvText' | 'engineEnvText'>): Record<string, string> {
  return { ...parseEnvText(files.engineEnvText), ...parseEnvText(files.baseEnvText) };
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
