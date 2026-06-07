import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Replace an existing `KEY=` line, or append one if absent. */
function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }
  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return `${text}${needsNewline ? '\n' : ''}${line}\n`;
}

/**
 * Write `.env.<profile>` as a full copy of base `.env` with STAMP set, so the
 * submodule's `check_stamp` guard (which greps STAMP from the env file it reads)
 * sees a non-empty value and never hits its interactive "Continue anyway?"
 * prompt — that prompt would EOF-abort under the manager's stdin-less runner.
 *
 * It must be a COMPLETE env file (not just the STAMP line): deploy.sh switches
 * ENV_FILE to `.env.<profile>` when present and uses it as compose's
 * `--env-file`, so a partial file would drop every other value. The
 * authoritative per-container STAMP still flows via the `--stamp-id` CLI
 * override (.env.deploy), so the value written here only needs to be non-empty.
 *
 * No-ops when the stamp is blank. Returns the path written, or null if skipped.
 */
export function writeProfileStampEnv(
  name: string,
  stampId: string,
): string | null {
  const stamp = stampId.replace(/^0x/, '').trim();
  if (!stamp) return null;

  const base = existsSync(baseEnvPath())
    ? readFileSync(baseEnvPath(), 'utf8')
    : '';
  const contents = upsertEnvLine(base, 'STAMP', stamp);

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
