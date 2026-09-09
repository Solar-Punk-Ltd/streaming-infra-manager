import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import type { StackContract } from '@streaming-infra-manager/common';
import { EventBus } from '../../src/domain/EventBus.js';
import { ProfileConfigError } from '../../src/domain/errors/index.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { deployOwnerOf, type ExpectedDeployOwner, type BuildDescriptor, type ClaimedDeploy } from '../../src/domain/versions/buildLedger.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { buildDirFor, deployRootProblem } from '../../src/domain/versions/stackPaths.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';

const port = Number(process.env.T04A_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04a_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const CONTRACT: StackContract = {
  ports: [{ name: 'RTMP_PORT', defaultPort: 1935, slotBase: 19000, protocol: 'tcp', service: 'srs' }],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false, sharedImageTags: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'test/srs', ome: null },
  warnings: [],
  allocationProblem: null,
};

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the test interleaving did not finish')), 10000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('build snapshot claims in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let claimantPool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let versions: PostgresStackVersionRepository;
  let ledger: PostgresBuildLedger;
  let service: StackVersionService;
  let selected: StackVersionRecord;
  let initialOwner: ExpectedDeployOwner;

  beforeEach(async () => {
    schema = `t04a_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't04a-artifacts-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 5, options: `-c search_path=${schema}` });
    claimantPool = new pg.Pool({ ...connection, max: 1, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    versions = new PostgresStackVersionRepository(pool);
    profiles = new ProfileRepository(pool);
    const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('this test must not inspect containers'); } };
    ledger = new PostgresBuildLedger(claimantPool, observer, root);
    const pruneLedger = new PostgresBuildLedger(pool, observer, root);
    service = new StackVersionService(versions, { run: () => { throw new Error('this test must not build'); } }, new EventBus(), root, pruneLedger);
    const version = await versions.insert({ name: 'test-stack', gitRef: 'test', rootPath: join(root, 'test-stack') });
    await artifact(A);
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract: CONTRACT }))!;
    await profiles.insertWithFreeSlot('test-profile', 'streamer', 'RUNNING', {}, {
      stackVersionId: selected.id, slotCap: 99, daemonId: 'synthetic-daemon', table: CONTRACT.ports,
    });
    initialOwner = deployOwnerOf((await profiles.findByName('test-profile'))!);
    await pool.query("UPDATE profiles SET last_error = 'previous failure', last_error_at = '2026-01-01' WHERE name = 'test-profile'");
  });

  afterEach(async () => {
    await claimantPool?.end();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function artifact(buildId: string, manifest = { buildId, commit: buildId.slice(0, 40) }): Promise<string> {
    const path = buildDirFor(root, 'test-stack', buildId);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, BUILD_MANIFEST_FILE), JSON.stringify({ ...manifest, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
    await writeFile(join(path, BUILD_COMPLETE_MARKER), '');
    return path;
  }

  function gateConnection() {
    const entered = signal();
    const release = signal();
    const connect = claimantPool.connect.bind(claimantPool);
    claimantPool.connect = (async () => {
      entered.resolve();
      await release.promise;
      return connect();
    }) as Pool['connect'];
    return { entered, release };
  }

  for (const method of ['claim', 'describe'] as const) {
    describe(method, () => {
      beforeEach(async () => {
        if (method === 'describe') await pool.query("UPDATE profiles SET status = 'DEPLOYING' WHERE name = 'test-profile'");
      });
    function capture(version = selected): Promise<ClaimedDeploy | BuildDescriptor | null> {
      return method === 'claim'
        ? ledger.claim('test-profile', ['RUNNING'], version, ['srs'], { ...initialOwner, intent: 'preserve' })
        : ledger.describe('test-profile', version, ['srs'], initialOwner);
    }

    async function refusalAfter(change: () => Promise<unknown>, reason = /changed|no longer exists/): Promise<void> {
      const before = await profiles.findByName('test-profile');
      assert.equal(deployRootProblem(selected), null);
      const gate = gateConnection();
      const captured = capture().then(value => ({ value, error: null }), error => ({ value: null, error }));
      try {
        await bounded(gate.entered.promise);
        await change();
      } finally {
        gate.release.resolve();
      }
      const outcome = await bounded(captured);
      assert.ok(outcome.error instanceof ProfileConfigError, 'capture must explicitly refuse the invalid snapshot');
      assert.match(outcome.error.reason, reason);
      assert.equal((await pool.query('SELECT id FROM build_references')).rowCount, 0);
      assert.deepEqual(await profiles.findByName('test-profile'), before, 'a refused capture changes no profile fields');
    }

    it(`${method} refuses A after B/C publication and pruning finish before its share lock`, async () => {
      await refusalAfter(async () => {
        for (const buildId of [B, C]) {
          await artifact(buildId);
          await versions.publish(selected.id, { buildId, commitSha: buildId, contract: CONTRACT });
        }
        assert.deepEqual((await service.pruneBuilds(selected.id)).removed, [A]);
        assert.equal(existsSync(buildDirFor(root, 'test-stack', A)), false, 'the old artifact is gone before claim resumes');
      });
    });

    it(`${method} protects A when its reference commits before later publications and pruning`, async () => {
      const result = await capture();
      assert.ok(result);
      for (const buildId of [B, C]) {
        await artifact(buildId);
        await versions.publish(selected.id, { buildId, commitSha: buildId, contract: CONTRACT });
      }
      assert.ok((await service.pruneBuilds(selected.id)).kept.includes(A));
      assert.ok(existsSync(buildDirFor(root, 'test-stack', A)));
      assert.equal((await pool.query('SELECT build_id FROM build_references')).rows[0]?.build_id, A);
    });

    it(`${method} refuses a different build of the same commit`, async () => {
      await refusalAfter(async () => {
        await artifact(`${A}-r1`);
        await versions.publish(selected.id, { buildId: `${A}-r1`, commitSha: A, contract: CONTRACT });
      });
    });

    it(`${method} refuses a changed contract without changing build identity`, async () => {
      await refusalAfter(() => versions.setContract(selected.id, { ...CONTRACT, maxSlot: 12 }));
    });

    for (const field of ['name', 'root_path', 'layout', 'commit_sha'] as const) {
      it(`${method} refuses a changed ${field}`, async () => {
        const replacement = { name: 'changed-stack', root_path: join(root, 'changed'), layout: 'legacy', commit_sha: B }[field];
        await refusalAfter(() => pool.query(`UPDATE stack_versions SET ${field} = $2 WHERE id = $1`, [selected.id, replacement]));
      });
    }

    it(`${method} refuses a legacy-to-builds publication after its read`, async () => {
      await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [selected.id]);
      selected = (await versions.findById(selected.id))!;
      await refusalAfter(() => versions.publish(selected.id, { buildId: A, commitSha: A, contract: CONTRACT }));
    });

    it(`${method} refuses a version row removed after its read`, async () => {
      await pool.query('UPDATE profiles SET stack_version_id = 1 WHERE name = $1', ['test-profile']);
      await refusalAfter(() => versions.remove(selected.id));
    });

    for (const missing of [BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, 'directory'] as const) {
      it(`${method} rechecks a missing ${missing} after its earlier precheck`, async () => {
        await refusalAfter(() => rm(missing === 'directory'
          ? buildDirFor(root, 'test-stack', A)
          : join(buildDirFor(root, 'test-stack', A), missing), { recursive: true }), /cannot be deployed from/);
      });
    }

    for (const field of ['buildId', 'commit'] as const) {
      it(`${method} refuses a manifest naming a different ${field}`, async () => {
        await refusalAfter(() => artifact(A, { buildId: A, commit: A, [field]: B }), /manifest|identity/);
      });
    }

    it(`${method} accepts metadata changes and structural JSON key reordering`, async () => {
      const gate = gateConnection();
      const captured = capture();
      try {
        await bounded(gate.entered.promise);
        await versions.setDefault(selected.id);
        await versions.setTested(selected.id, true);
        await versions.markBuilding(selected.id);
        await versions.setContract(selected.id, Object.fromEntries(Object.entries(CONTRACT).reverse()) as unknown as StackContract);
        await pool.query("UPDATE stack_versions SET previous_build_id = $2, git_ref = 'next', built_at = NOW(), last_error = 'update note' WHERE id = $1", [selected.id, B]);
      } finally {
        gate.release.resolve();
      }
      const result = await bounded(captured);
      assert.ok(result);
      const descriptor = 'descriptor' in result ? result.descriptor : result;
      assert.equal(descriptor.buildId, A);
      assert.equal(descriptor.version?.commitSha, A);
      assert.equal((await pool.query('SELECT id FROM build_references')).rowCount, 1);
    });

    for (const buildId of [A, null]) {
      it(`${method} refuses a schema-permitted builds row with no root and build ${buildId ?? 'unset'}`, async () => {
        await pool.query('UPDATE stack_versions SET root_path = NULL, build_id = $2 WHERE id = $1', [selected.id, buildId]);
        selected = (await versions.findById(selected.id))!;
        const before = await profiles.findByName('test-profile');
        await assert.rejects(capture(), (err: unknown) => err instanceof ProfileConfigError && /artifact root/.test(err.reason));
        assert.equal((await pool.query('SELECT id FROM build_references')).rowCount, 0);
        assert.deepEqual(await profiles.findByName('test-profile'), before);
      });
    }
    });
  }
});
