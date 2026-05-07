import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  /**
   * Absolute path to the streaming-infra-manager checkout. Sourced from
   * REPO_HOST_PATH so the same value drives:
   *   - the bind mount in manager/docker-compose.yml (host side)
   *   - the path the running process uses to find deploy scripts (container side)
   * Mirroring lets the deploy script ask the host docker daemon to bind-mount
   * paths under it and have them actually resolve.
   */
  repoRoot: string;
  logLevel: string;
}

export const config: AppConfig = {
  port: Number(optional('MANAGER_PORT', '9876')),
  host: optional('MANAGER_HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  repoRoot: required('REPO_HOST_PATH'),
  logLevel: optional('LOG_LEVEL', 'info'),
};
