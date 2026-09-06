import 'dotenv/config';

import {
  bzzToPlur,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
} from '@streaming-infra-manager/common';

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

/**
 * How little a bee node may have in its chequebook before the manager refuses
 * to start an uploader against it, read once at startup.
 *
 * A bad value stops the process rather than falling back to the default: the
 * whole point of the setting is that one number gates deploys and is shown in
 * the UI, and quietly using a different one than the operator wrote is worse
 * than not starting.
 */
function chequebookFloorPlur(): bigint {
  const raw = optional('CHEQUEBOOK_FLOOR_BZZ', DEFAULT_CHEQUEBOOK_FLOOR_BZZ);
  const plur = bzzToPlur(raw);
  if (plur === null) {
    throw new Error(
      `CHEQUEBOOK_FLOOR_BZZ must be a BZZ amount above zero with at most 16 decimal places, got: ${raw}`,
    );
  }
  return plur;
}

export interface AppConfig {
  port: number;
  host: string;
  publicHost: string;
  databaseUrl: string;
  logLevel: string;
  chequebookFloorPlur: bigint;
}

export const config: AppConfig = {
  port: Number(optional('MANAGER_PORT', '9876')),
  host: optional('MANAGER_HOST', '0.0.0.0'),
  publicHost: optional('PUBLIC_HOST', ''),
  databaseUrl: required('DATABASE_URL'),
  logLevel: optional('LOG_LEVEL', 'info'),
  chequebookFloorPlur: chequebookFloorPlur(),
};
