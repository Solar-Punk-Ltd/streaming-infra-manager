import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Paths into the swarm-hls-stream submodule. Resolved relative to this file so
 * the same code works in:
 *   - dev (`pnpm dev` from manager/, ts source at src/utils/repo.ts)
 *   - prod (Docker image with manager built at /app/dist and submodule at
 *     /app/swarm-hls-stream — baked in by the Dockerfile)
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const SUBMODULE = resolve(HERE, '../../swarm-hls-stream');
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

/**
 * Seed `.env.<name>` from the base `.env` if it doesn't exist. The deploy
 * script's `require_env` errors out for non-default profiles when the per-
 * profile env file is missing, so creating it on profile registration avoids
 * a confusing first-deploy failure.
 */

// TODO refactor to alwass seed not lookup
export function ensureProfileEnv(name: string): boolean {
  const dest = profileEnvPath(name);
  if (existsSync(dest)) return false;

  const base = baseEnvPath();
  if (!existsSync(base)) {
    throw new Error(
      `Cannot seed .env.${name}: base file ${base} not found. ` +
        `Set up swarm-hls-stream/.env first.`,
    );
  }
  copyFileSync(base, dest);
  return true;
}

/**
 * Parse `.env.<name>` into a flat KEY→VALUE map. Returns an empty object if
 * the file is missing. Ignores blank lines and `#`-comments. Strips matched
 * surrounding single or double quotes from values; does not interpret
 * backslash escapes.
 */
export function parseProfileEnv(name: string): Record<string, string> {
  const path = profileEnvPath(name);
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

/** Best-effort delete of the per-profile env file. */
export function deleteProfileEnv(name: string): boolean {
  const path = profileEnvPath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
