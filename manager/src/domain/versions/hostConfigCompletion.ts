import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { envKeyIn, withHostConfigLock } from './hostConfigCapture.js';

/**
 * Settings a version declares that the host's own files do not carry yet.
 *
 * A version of the stack that adds a setting ships it in its `.env.sample`,
 * and the host's `.env` is the operator's file, which no version moves. The
 * bundled version is built here at boot with nobody watching, so a base env
 * one commit behind the sample completes itself from that sample rather than
 * failing the build. Only keys are added, always with the sample's own line, so
 * a value the sample leaves blank stays blank and is visibly still to be filled
 * in. The operator's own lines keep their bytes, and the result is committed as
 * one revision under the lock the editing script uses.
 */

/** Which keys were appended to which file, by relative posix path. */
export type CompletedSettings = Record<string, string[]>;

const BASE_ENV = '.env';
const SAMPLE_SUFFIX = '.sample';
const ENGINES_DIR = 'engines';

/** Live file to the sample it is completed from, both relative posix paths. */
interface SamplePair {
  live: string;
  sample: string;
}

/** The base env and every engine env this version ships a sample for. */
function samplePairsIn(staging: string): SamplePair[] {
  const pairs: SamplePair[] = [{ live: BASE_ENV, sample: `${BASE_ENV}${SAMPLE_SUFFIX}` }];
  const engines = join(staging, ENGINES_DIR);
  if (existsSync(engines) && statSync(engines).isDirectory()) {
    for (const engine of readdirSync(engines).sort()) {
      pairs.push({
        live: `${ENGINES_DIR}/${engine}/${BASE_ENV}`,
        sample: `${ENGINES_DIR}/${engine}/${BASE_ENV}${SAMPLE_SUFFIX}`,
      });
    }
  }
  return pairs;
}

interface MissingSettings {
  keys: string[];
  lines: string[];
}

/** The sample's own lines for the keys the current text does not assign, in the sample's order. */
function missingFrom(current: string, sample: string): MissingSettings {
  const assigned = new Set<string>();
  for (const line of current.split('\n')) {
    const key = envKeyIn(line);
    if (key) assigned.add(key);
  }
  const missing: MissingSettings = { keys: [], lines: [] };
  for (const line of sample.split('\n')) {
    const key = envKeyIn(line);
    if (key === null || assigned.has(key)) continue;
    assigned.add(key);
    missing.keys.push(key);
    missing.lines.push(line);
  }
  return missing;
}

/** The lines appended, with a separator only where the file left its last line unterminated. */
function withLines(current: Buffer, lines: readonly string[]): Buffer {
  const text = current.toString('utf8');
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  return Buffer.concat([current, Buffer.from(`${separator}${lines.join('\n')}\n`, 'utf8')]);
}

/**
 * Completes the host's env files from the samples the build's tree ships, and
 * answers what was added. A file the host does not keep, or one the version
 * ships no sample for, is left alone: only what is already the host's own is
 * ever written to.
 */
export async function completeHostConfigFromSamples(
  configRoot: string,
  staging: string,
): Promise<CompletedSettings> {
  // The live files are read and written back under one acquisition of the
  // lock, so an edit that lands between the two is not overwritten.
  return withHostConfigLock(configRoot, async (commit) => {
    const completed: CompletedSettings = {};
    const files: Record<string, Buffer> = {};
    for (const { live, sample } of samplePairsIn(staging)) {
      const livePath = join(configRoot, live);
      const samplePath = join(staging, sample);
      if (!existsSync(livePath) || !existsSync(samplePath)) continue;
      const current = await readFile(livePath);
      const missing = missingFrom(current.toString('utf8'), await readFile(samplePath, 'utf8'));
      if (missing.keys.length === 0) continue;
      completed[live] = missing.keys;
      files[live] = withLines(current, missing.lines);
    }
    if (Object.keys(files).length > 0) await commit(files);
    return completed;
  });
}
