import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
const { Pool } = pg;
type Pool = pg.Pool;

import { Logger } from './Logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');
const MIGRATION_LOCK_KEY = 0x6d696772;
const CLEANUP_TIMEOUT_MS = 5000;

const logger = Logger.getInstance();

async function boundedCleanup<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Migration connection cleanup timed out.')), CLEANUP_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer!); }
}

export class Database {
  public readonly pool: Pool;

  constructor(connectionString: string, private readonly migrationsDir = MIGRATIONS_DIR) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    let locked = false;
    let discardClient = true;
    let primaryFailed = false;
    let connectionFailure: Error | null = null;
    const onConnectionError = (error: Error) => {
      connectionFailure = error;
      discardClient = true;
      logger.error('[Database] Migration connection failed. Discarding the connection.');
    };
    client.on('error', onConnectionError);
    try {
      // A session lock spans ledger creation and all per-file transactions, including fresh concurrent startup.
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      locked = true;
      discardClient = false;
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name        TEXT PRIMARY KEY,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const files = readdirSync(this.migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const seen = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
        if (seen.rowCount && seen.rowCount > 0) continue;

        const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [
            file,
          ]);
          await client.query('COMMIT');
          logger.info(`[Database] Applied migration: ${file}`);
        } catch (err) {
          try { await boundedCleanup(client.query('ROLLBACK')); }
          catch {
            discardClient = true;
            logger.error('[Database] Migration rollback could not be confirmed. Discarding the connection.');
          }
          throw err;
        }
      }
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      let unlockFailed = false;
      if (locked && !discardClient) {
        try {
          const result = await boundedCleanup(client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock($1) AS unlocked', [MIGRATION_LOCK_KEY],
          ));
          if (result.rows[0]?.unlocked !== true) throw new Error('Migration lock ownership was lost.');
        } catch {
          discardClient = true;
          unlockFailed = true;
          logger.error('[Database] Migration lock release could not be confirmed. Discarding the connection.');
        }
      }
      client.release(discardClient);
      client.removeListener('error', onConnectionError);
      if (connectionFailure && !primaryFailed) throw connectionFailure;
      if (unlockFailed && !primaryFailed) throw new Error('Migration lock release could not be confirmed. Connection discarded.');
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
