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
  logLevel: string;
}

export const config: AppConfig = {
  port: Number(optional('MANAGER_PORT', '9876')),
  host: optional('MANAGER_HOST', '0.0.0.0'),
  databaseUrl: required('DATABASE_URL'),
  logLevel: optional('LOG_LEVEL', 'info'),
};
