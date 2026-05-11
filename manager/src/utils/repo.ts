import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
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

/** Best-effort delete of the per-profile env file. */
export function deleteProfileEnv(name: string): boolean {
  const path = profileEnvPath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
