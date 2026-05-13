import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function deleteProfileEnv(name: string): boolean {
  const path = profileEnvPath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
