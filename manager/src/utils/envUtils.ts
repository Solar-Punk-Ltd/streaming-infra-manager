import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abrLadderEnvValue,
  beePublishersProblem,
  beeUrlProblem,
  type EngineName,
  OME_SERVICE,
} from '@streaming-infra-manager/common';

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: the swarm-hls-stream submodule sits next to the manager source tree.
// On the deploy server the submodule lives outside the image (bind-mounted
// from the host) so the path differs from the in-image one — SHLS_ROOT lets
// docker-compose.yml point at the bind-mount without code changes.
export const SUBMODULE =
  process.env.SHLS_ROOT ?? resolve(HERE, '../../swarm-hls-stream');
export const SCRIPTS_DIR = join(SUBMODULE, 'deploy', 'scripts');

export const SCRIPT_DEPLOY = join(SCRIPTS_DIR, 'deploy.sh');
export const SCRIPT_STOP = join(SCRIPTS_DIR, 'stop.sh');
export const SCRIPT_CLEAN = join(SCRIPTS_DIR, 'clean.sh');
export const SCRIPT_HEALTH = join(SCRIPTS_DIR, 'health.sh');

export function profileEnvPath(name: string): string {
  return join(SUBMODULE, `.env.${name}`);
}

export function baseEnvPath(): string {
  return join(SUBMODULE, '.env');
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const out: Record<string, string> = {};
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function parseBaseEnv(): Record<string, string> {
  return parseEnvFile(baseEnvPath());
}

const BOOTSTRAP_FILES = [
  { src: join(SUBMODULE, '.env.sample'), dst: join(SUBMODULE, '.env') },
  {
    src: join(SUBMODULE, 'deploy', 'config.sample.json'),
    dst: join(SUBMODULE, 'deploy', 'config.json'),
  },
];

export async function bootstrapSubmoduleDefaults(): Promise<string[]> {
  const created: string[] = [];
  for (const { src, dst } of BOOTSTRAP_FILES) {
    if (!existsSync(dst) && existsSync(src)) {
      await copyFile(src, dst);
      created.push(dst);
    }
  }
  return created;
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm');
  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }
  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return `${text}${needsNewline ? '\n' : ''}${line}\n`;
}

export interface ProfileEnvValues {
  engine: EngineName;
  stampId?: string | null;
  /** A pasted BEE_PUBLISHERS: publish to an ABR node pool rather than STAMP. */
  beePublishers?: string | null;
  /**
   * An explicit bee API URL. Written only when there is no local bee-uploader —
   * deploy.sh's resolve_bee_url overrides this file's value whenever there is.
   */
  beeUrl?: string | null;

  omeSrtPort?: number;
  omeHlsPort?: number;
}

// deploy.sh switches ENV_FILE to .env.<profile> when present and uses it as
// compose's --env-file, so this must be a full copy of base .env with the
// per-profile keys upserted, not just the overridden lines.
export function writeProfileEnv(
  name: string,
  values: ProfileEnvValues,
): string {
  let contents = existsSync(baseEnvPath())
    ? readFileSync(baseEnvPath(), 'utf8')
    : '';

  contents = upsertEnvLine(contents, 'ENGINE', values.engine);

  const stamp = values.stampId?.replace(/^0x/, '').trim();
  if (stamp) {
    if (!/^[0-9a-fA-F]+$/.test(stamp)) {
      throw new Error('refusing to write a non-hex STAMP to the env file');
    }
    contents = upsertEnvLine(contents, 'STAMP', stamp);
  }

  // A pool-backed uploader publishes to the ABR node pool's nodes rather than to
  // this profile's own bee-uploader. ABR_ENABLED and ABR_LADDER go here too, not
  // into engines/srs/.env.<profile>: the root env wins over it in deploy.sh, both
  // srs and the uploader read them from the compose environment, and the
  // uploader refuses to start unless the publishers cover the ladder exactly —
  // so the two are written by one hand, from one definition.
  const publishers = values.beePublishers?.trim();
  if (publishers) {
    const problem = beePublishersProblem(publishers);
    if (problem) {
      throw new Error(
        `refusing to write BEE_PUBLISHERS to the env file: ${problem}`,
      );
    }
    if (values.engine === OME_SERVICE) {
      throw new Error(
        'BEE_PUBLISHERS requires the srs engine — the ABR ladder is SRS-only',
      );
    }
    contents = upsertEnvLine(contents, 'BEE_PUBLISHERS', publishers);
    contents = upsertEnvLine(contents, 'ABR_ENABLED', 'true');
    contents = upsertEnvLine(contents, 'ABR_LADDER', abrLadderEnvValue());
    // STAMP is deliberately left alone, tempting though it is to clear: a
    // pool-backed uploader owns no batch, and .env.<profile> is a full copy of
    // the base .env, so whatever STAMP was configured there rides along and
    // belongs to someone else. But the uploader declares `stamp: required(…)`
    // unconditionally and its `required()` throws on an empty string, so
    // blanking it stops the container at config load — even though `config.stamp`
    // is only ever read by `BeePublisherPool.single()`, which pool mode does not
    // call. Making STAMP conditional belongs upstream; until then a stray value
    // is inert and an empty one is fatal.
  }

  const beeUrl = values.beeUrl?.trim();
  if (beeUrl && !publishers) {
    const problem = beeUrlProblem(beeUrl);
    if (problem) {
      throw new Error(`refusing to write BEE_URL to the env file: ${problem}`);
    }
    contents = upsertEnvLine(contents, 'BEE_URL', beeUrl);
  }

  if (values.engine === OME_SERVICE) {
    if (values.omeSrtPort) {
      contents = upsertEnvLine(
        contents,
        'OME_SRT_PORT',
        String(values.omeSrtPort),
      );
    }
    if (values.omeHlsPort) {
      contents = upsertEnvLine(
        contents,
        'OME_HLS_PORT',
        String(values.omeHlsPort),
      );
    }
  }

  const path = profileEnvPath(name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

export function deleteProfileEnv(name: string): boolean {
  const path = profileEnvPath(name);

  if (!existsSync(path)) {
    return false;
  }

  unlinkSync(path);
  return true;
}
