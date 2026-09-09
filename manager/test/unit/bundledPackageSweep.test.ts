/**
 * What a finished publication removes from the host: the shipped packages, the
 * claimed copies and the private materializations of shipments that can never
 * publish again. Each of those directories holds the streaming stack's own
 * .env, deploy config and engine envs, so keeping them forever keeps every
 * secret every deploy ever shipped.
 *
 * Unit test over a temporary tree with the journal replaced, so no database is
 * touched. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { BundledShipmentRecord } from '../../src/domain/versions/BundledShipment.js';
import { sweepBundledPackages, type BundledShipmentJournal } from '../../src/domain/versions/bundledPackageSweep.js';
import {
  bundledPackageClaimsRootFor,
  bundledPackagesRootFor,
  configRootFor,
  materializationsRootFor,
} from '../../src/domain/versions/stackPaths.js';

const BUNDLED = 'bundled';
const COMMIT = 'a'.repeat(40);

type ShipmentState = BundledShipmentRecord['state'];

describe('sweeping the packages a deploy left on the host', () => {
  let root: string; let versionsRoot: string;
  let records: Map<string, BundledShipmentRecord>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-sweep-'));
    versionsRoot = join(root, 'versions');
    await mkdir(bundledPackageClaimsRootFor(versionsRoot), { recursive: true });
    await mkdir(materializationsRootFor(configRootFor(versionsRoot, BUNDLED)), { recursive: true });
    records = new Map();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function journal(): BundledShipmentJournal {
    return {
      find: async (shipmentId) => records.get(shipmentId) ?? null,
      findByMaterialization: async (materializationId) =>
        [...records.values()].find((record) => record.materializationId === materializationId) ?? null,
    };
  }

  function record(state: ShipmentState, options: { materializationId?: string; kind?: 'new' | 'reuse' } = {}): string {
    const shipmentId = randomUUID();
    records.set(shipmentId, {
      shipmentId, versionId: 1, packageDigest: 'd'.repeat(64), commitSha: COMMIT, expectedRevision: '0',
      rootPath: configRootFor(versionsRoot, BUNDLED), state, candidateBuildId: COMMIT,
      candidateKind: options.kind ?? 'new', candidateManifest: null, candidateMetadata: null,
      materializationId: options.materializationId ?? null, artifactDigest: null, candidateContract: null,
      receipt: null, createdAt: new Date('2026-09-09T00:00:00.000Z'),
    });
    return shipmentId;
  }

  async function directory(path: string): Promise<string> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '.env'), 'SRT_PASSPHRASE=synthetic-passphrase\n', { mode: 0o600 });
    return path;
  }
  function sealed(shipmentId: string, suffix = ''): string {
    return join(bundledPackagesRootFor(versionsRoot), `sealed-${shipmentId}${suffix}`);
  }
  function claim(shipmentId: string): string {
    return join(bundledPackageClaimsRootFor(versionsRoot), shipmentId);
  }
  function materialization(materializationId: string): string {
    return join(materializationsRootFor(configRootFor(versionsRoot, BUNDLED)), materializationId);
  }

  it('removes the package and the claim of a shipment that published, and says which by name', async () => {
    const published = record('published');
    await directory(sealed(published));
    await directory(claim(published));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(sealed(published)), false, 'the shipped package is gone');
    assert.equal(existsSync(claim(published)), false, 'so is the copy publication claimed');
    assert.deepEqual(swept.removed.sort(), [`bundled.packages/claims/${published}`, `bundled.packages/sealed-${published}`].sort());
    assert.deepEqual(swept.kept, []);
    assert.deepEqual(swept.unknown, []);
  });

  it('removes the package of a shipment a newer publication superseded', async () => {
    const superseded = record('superseded');
    await directory(sealed(superseded));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(sealed(superseded)), false);
    assert.deepEqual(swept.removed, [`bundled.packages/sealed-${superseded}`]);
  });

  for (const state of ['registered', 'prepared'] as const) {
    it(`keeps the package of a ${state} shipment, which may still publish`, async () => {
      const pending = record(state);
      await directory(sealed(pending));
      await directory(claim(pending));

      const swept = await sweepBundledPackages(versionsRoot, journal());

      assert.equal(existsSync(sealed(pending)), true);
      assert.equal(existsSync(claim(pending)), true);
      assert.deepEqual(swept.kept.sort(), [`bundled.packages/claims/${pending}`, `bundled.packages/sealed-${pending}`].sort());
      assert.deepEqual(swept.removed, []);
    });
  }

  it('keeps a directory whose id the journal never registered, and reports it', async () => {
    const stranger = randomUUID();
    await directory(sealed(stranger));
    await directory(claim(stranger));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(sealed(stranger)), true);
    assert.equal(existsSync(claim(stranger)), true);
    assert.deepEqual(swept.unknown.sort(), [`bundled.packages/claims/${stranger}`, `bundled.packages/sealed-${stranger}`].sort());
    assert.deepEqual(swept.removed, []);
  });

  it('leaves a staging directory of a copy still arriving alone, and never names it', async () => {
    const published = record('published');
    await directory(sealed(published, '.tmp'));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(sealed(published, '.tmp')), true);
    assert.deepEqual([...swept.removed, ...swept.kept, ...swept.unknown], []);
  });

  it('leaves anything in the packages root that is not a sealed package alone', async () => {
    await directory(join(bundledPackagesRootFor(versionsRoot), 'sealed-not-an-identity'));
    await directory(join(bundledPackagesRootFor(versionsRoot), 'notes'));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.deepEqual([...swept.removed, ...swept.kept, ...swept.unknown], []);
    assert.equal(existsSync(join(bundledPackagesRootFor(versionsRoot), 'notes')), true);
  });

  it('removes the private copy of a superseded shipment that had made one of its own', async () => {
    const materializationId = randomUUID();
    record('superseded', { materializationId, kind: 'new' });
    await directory(materialization(materializationId));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(materialization(materializationId)), false);
    assert.deepEqual(swept.removed, [`bundled.materializations/${materializationId}`]);
  });

  it('keeps the private copy of a shipment that published, because its build was renamed out of it', async () => {
    const materializationId = randomUUID();
    record('published', { materializationId, kind: 'new' });
    await directory(materialization(materializationId));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(materialization(materializationId)), true);
    assert.deepEqual(swept.kept, [`bundled.materializations/${materializationId}`]);
  });

  it('keeps a private copy the journal knows nothing about, and reports it so it is not kept forever', async () => {
    const materializationId = randomUUID();
    await directory(materialization(materializationId));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.equal(existsSync(materialization(materializationId)), true);
    assert.deepEqual(swept.unknown, [`bundled.materializations/${materializationId}`]);
    assert.deepEqual(swept.kept, []);
  });

  it('reports the one package it could not remove and removes the others, rather than stopping there', async () => {
    const linked = record('published');
    const first = record('published');
    const second = record('published');
    const elsewhere = await directory(join(root, 'elsewhere'));
    await symlink(elsewhere, sealed(linked));
    await directory(sealed(first));
    await directory(sealed(second));

    const swept = await sweepBundledPackages(versionsRoot, journal());

    assert.deepEqual(swept.removed.sort(), [`bundled.packages/sealed-${first}`, `bundled.packages/sealed-${second}`].sort());
    assert.deepEqual(swept.failed.map((failure) => failure.name), [`bundled.packages/sealed-${linked}`]);
    assert.match(swept.failed[0]!.reason, /symbolic link|directory/i, 'and says what stopped it');
    assert.equal(existsSync(join(elsewhere, '.env')), true, 'what the link pointed at is untouched');
  });

  it('answers nothing at all on a host where no package has ever been shipped', async () => {
    await rm(bundledPackagesRootFor(versionsRoot), { recursive: true, force: true });
    await rm(materializationsRootFor(configRootFor(versionsRoot, BUNDLED)), { recursive: true, force: true });

    assert.deepEqual(await sweepBundledPackages(versionsRoot, journal()), { removed: [], kept: [], unknown: [], failed: [] });
  });
});
