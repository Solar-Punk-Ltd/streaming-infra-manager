/**
 * One manager upgrade owns the host for its whole run: it stops the old api,
 * migrates, starts the project, verifies it, and then waits for the api's own
 * boot to build the stack commit the manager pins.
 *
 * There is no shipment any more. The deploy carries the manager and one pinned
 * commit, and the host fetches and builds that commit itself, so there is
 * nothing for this command to publish and nothing to replay. What it still owns
 * is the directory that stops a second upgrade starting beside it.
 *
 * Unit test with the host operations replaced. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  runManagerUpgrade,
  type BundledBuildOutcome,
  type ManagerPublication,
  type ManagerUpgradeOperations,
  type ManagerUpgradeRequest,
} from '../../src/domain/versions/ManagerUpgrade.js';

const A = 'a'.repeat(40);
const PIN = 'c'.repeat(40);
function request(commit = A): ManagerUpgradeRequest {
  return { manager: { sourceCommit: commit, sourceDigest: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}` }, project: 'manager' };
}
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

describe('one manager upgrade owns every active project mutation', () => {
  let root: string; let environment: { guardRoot: string; mutableRoot: string };
  let publication: ManagerPublication; let bundled: BundledBuildOutcome;
  let actions: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-')); environment = { guardRoot: join(root, 'upgrade-owner'), mutableRoot: join(root, 'manager') };
    publication = { schema: 'current' };
    bundled = { state: 'ready', commit: PIN, buildId: PIN, problem: null };
    actions = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function operations(): ManagerUpgradeOperations {
    return {
      readPublication: async () => publication,
      stopApi: async () => { actions.push('stop-api'); },
      migrate: async () => { actions.push('migrate'); },
      startProject: async () => { actions.push('start-api-web-edge'); },
      verifyProject: async () => { actions.push('verify-project'); },
      awaitBundledBuild: async () => { actions.push('await-bundled-build'); return bundled; },
    };
  }

  it('persists exact identity and the phase before each effect, then releases only after the bundled build', async () => {
    const input = request(); const ops = operations();
    for (const [method, phase] of [['stopApi', 'stopping'], ['migrate', 'migrating'],
      ['startProject', 'starting'], ['verifyProject', 'verifying'], ['awaitBundledBuild', 'bundled']] as const) {
      const original = ops[method];
      Object.assign(ops, { [method]: async (captured: ManagerUpgradeRequest) => {
        const recorded = JSON.parse(await readFile(join(environment.guardRoot, 'owner.json'), 'utf8'));
        assert.deepEqual(recorded.request, input); assert.equal(recorded.phase, phase);
        return original(captured);
      } });
    }
    const result = await runManagerUpgrade(environment, input, ops);
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.bundled, bundled);
    assert.deepEqual(actions, ['stop-api', 'migrate', 'start-api-web-edge', 'verify-project', 'await-bundled-build']);
    assert.equal((await readdir(root)).includes('upgrade-owner'), false);
  });

  it('answers a bundled build that failed, and still lets go of the host it holds', async () => {
    bundled = { state: 'failed', commit: PIN, buildId: null, problem: 'could not reach github' };

    const result = await runManagerUpgrade(environment, request(), operations());

    assert.deepEqual(result.bundled, bundled);
    assert.equal((await readdir(root)).includes('upgrade-owner'), false, 'the manager is up, so nothing is held for a person');
  });

  it('lets go of the host when the bundled wait itself fails, because the manager is already up', async () => {
    const ops = operations();
    ops.awaitBundledBuild = async () => { actions.push('await-bundled-build'); throw new Error('synthetic bundled read failure'); };

    await assert.rejects(runManagerUpgrade(environment, request(), ops), /synthetic bundled read failure/);

    assert.deepEqual(actions, ['stop-api', 'migrate', 'start-api-web-edge', 'verify-project', 'await-bundled-build']);
    assert.equal((await readdir(root)).includes('upgrade-owner'), false, 'a read that failed after the api was verified holds nothing for a person to remove');
  });

  it('keeps ownership through startup so a second upgrade cannot start or change any service', async () => {
    const entered = signal(); const release = signal(); const aOps = operations();
    aOps.startProject = async () => { actions.push('A-start-held'); entered.resolve(); await release.promise; };
    const running = runManagerUpgrade(environment, request(), aOps);
    try {
      await entered.promise; const before = [...actions];
      await assert.rejects(runManagerUpgrade(environment, request(), operations()), /upgrade.*owned|upgrade.*progress/i);
      assert.deepEqual(actions, before);
    } finally { release.resolve(); await running; }
  });

  it('does not release or steal uncertain ownership on a retry, even with an old timestamp', async () => {
    const input = request(); const ops = operations();
    ops.startProject = async () => { actions.push('uncertain-start'); throw new Error('synthetic command response loss'); };
    await assert.rejects(runManagerUpgrade(environment, input, ops), /response loss/);
    const before = await readFile(join(environment.guardRoot, 'owner.json'));
    await utimes(environment.guardRoot, new Date(0), new Date(0)); actions = [];
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /upgrade.*owned|upgrade.*progress/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readFile(join(environment.guardRoot, 'owner.json')), before);
  });

  it('runs again after a completed upgrade, because a deploy is not a shipment to replay', async () => {
    await runManagerUpgrade(environment, request(), operations()); actions = [];

    assert.equal((await runManagerUpgrade(environment, request('b'.repeat(40)), operations())).state, 'completed');
    assert.equal(actions.length, 5);
  });

  it('freezes caller identity before asynchronous publication reads', async () => {
    const input = request(); const original = structuredClone(input); const ops = operations(); const read = ops.readPublication;
    ops.readPublication = async selected => { input.manager.imageId = `sha256:${'0'.repeat(64)}`; return read(selected); };
    ops.stopApi = async selected => { assert.deepEqual(selected, original); };
    await runManagerUpgrade(environment, input, ops);
  });

  it('refuses a guard placed within the mutable installation destination', async () => {
    await assert.rejects(runManagerUpgrade({ ...environment, guardRoot: join(environment.mutableRoot, '.upgrade') }, request(), operations()), /outside|overlap/i);
    assert.deepEqual(actions, []);
  });

  it('rejects unexpected request fields before persisting any record', async () => {
    const input = { ...request(), unexpectedPrivateInput: 'synthetic-do-not-record' };
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /identity|fields/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readdir(root), []);
  });

  it('rejects unexpected nested identity fields before acquiring ownership', async () => {
    const input = request(); Object.assign(input.manager, { unexpectedPrivateInput: 'synthetic-do-not-record' });
    await assert.rejects(runManagerUpgrade(environment, input, operations()), /identity|fields/i);
    assert.deepEqual(actions, []); assert.deepEqual(await readdir(root), []);
  });

  it('refuses a schema state it cannot verify, before stopping anything', async () => {
    const ops = operations();
    ops.readPublication = async () => ({ schema: 'something-else' } as unknown as ManagerPublication);
    await assert.rejects(runManagerUpgrade(environment, request(), ops), /cannot be verified/i);
    assert.deepEqual(actions, []);
  });

  it('refuses an ancestor alias without touching what it points at', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); const alias = join(root, 'alias'); await symlink(outside, alias);
    await assert.rejects(runManagerUpgrade({ ...environment, guardRoot: join(alias, 'guard') }, request(), operations()));
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(actions, []);
  });
});
