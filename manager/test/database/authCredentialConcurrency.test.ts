import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool, type PoolClient } from 'pg';

import { PostgresCredentialRepository } from '../../src/domain/auth/PostgresCredentialRepository.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const SIGNAL_TIMEOUT_MS = 2_000;

function signal<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

async function boundedSignal<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), SIGNAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function untilBlocked(pool: Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid],
    )).rows[0]!.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected credential write did not wait for the user row lock');
}

function instrumentPool(
  pool: Pool,
  hook: (text: string, pid: number, run: () => Promise<unknown>) => Promise<unknown>,
): Pool {
  return { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return {
      release: () => client.release(),
      query: (text: string, values?: unknown[]) => hook(text, pid, () => client.query(text, values)),
    };
  } } as unknown as Pool;
}

describe('credential admission in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let userId: number;
  const clients: PoolClient[] = [];

  beforeEach(async () => {
    schema = `auth_credentials_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    userId = (await pool.query<{ id: number }>(
      "INSERT INTO users (username, password_hash) VALUES ('owner', 'old-hash') RETURNING id",
    )).rows[0]!.id;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('rejects session admission after a password replacement wins the user row lock', async () => {
    const blocker = await pool.connect();
    clients.push(blocker);
    await blocker.query('BEGIN');
    await blocker.query("UPDATE users SET password_hash = 'new-hash' WHERE id = $1", [userId]);
    const waiting = signal<number>();
    const repository = new PostgresCredentialRepository(instrumentPool(pool, async (text, pid, run) => {
      if (/SELECT password_hash/.test(text)) waiting.resolve(pid);
      return run();
    }));
    const admitted = repository.admitSession(userId, 'old-hash', {
      tokenHash: 'a'.repeat(64), userId, expiresAt: new Date(Date.now() + 60_000), ip: null, userAgent: null,
    }, new Date());

    await untilBlocked(pool, await boundedSignal(waiting.promise, 'the session credential query'));
    await blocker.query('COMMIT');

    assert.equal(await admitted, false);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });

  it('serializes password replacements and rejects the stale verified hash', async () => {
    const entered = signal();
    const release = signal();
    const first = new PostgresCredentialRepository(instrumentPool(pool, async (text, _pid, run) => {
      const result = await run();
      if (/SELECT password_hash/.test(text)) {
        entered.resolve();
        await release.promise;
      }
      return result;
    }));
    const waiting = signal<number>();
    const second = new PostgresCredentialRepository(instrumentPool(pool, async (text, pid, run) => {
      if (/SELECT password_hash/.test(text)) waiting.resolve(pid);
      return run();
    }));
    const winner = first.changePassword(userId, 'old-hash', 'winner-hash', 'a'.repeat(64));
    let stale: Promise<boolean> | undefined;
    try {
      await boundedSignal(entered.promise, 'the winning password replacement query');
      stale = second.changePassword(userId, 'old-hash', 'stale-hash', 'b'.repeat(64));
      await untilBlocked(pool, await boundedSignal(waiting.promise, 'the stale password replacement query'));
    } finally {
      release.resolve();
    }

    assert.equal(await winner, true);
    assert.ok(stale);
    assert.equal(await stale, false);
    assert.equal((await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1', [userId],
    )).rows[0]!.password_hash, 'winner-hash');
  });
});
