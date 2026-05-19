import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
const { Pool } = pg;
type Pool = pg.Pool;

import { Logger } from './Logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

const logger = Logger.getInstance();

export class Database {
  public readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const seen = await this.pool.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [file],
      );
      if (seen.rowCount && seen.rowCount > 0) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
        logger.info(`[Database] Applied migration: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
