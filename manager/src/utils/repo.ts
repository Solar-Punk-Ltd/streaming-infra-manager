import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { config } from './config.js';

/**
 * Paths into the swarm-hls-stream submodule. The repoRoot mirrors the host's
 * absolute path inside the manager container (see manager/docker-compose.yml)
 * so any bind mount that the deploy script asks `docker compose` to make is
 * valid on the host daemon side.
 */
export const SUBMODULE = join(config.repoRoot, 'swarm-hls-stream');
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
