import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { BUNDLED_VERSION_NAME } from '@streaming-infra-manager/common';

import type { BundledShipmentRecord } from './BundledShipment.js';
import { isBundledShipmentId } from './bundledShipmentPackage.js';
import { assertOwnedVersionParent } from './ownedVersionParent.js';
import {
  bundledPackageClaimsRootFor,
  bundledPackagesRootFor,
  configRootFor,
  materializationsRootFor,
} from './stackPaths.js';

/** What the sweep needs to know about a shipment, and nothing more. */
export interface BundledShipmentJournal {
  find(shipmentId: string): Promise<BundledShipmentRecord | null>;
  findByMaterialization(materializationId: string): Promise<BundledShipmentRecord | null>;
}

/** Directory names under the versions root. Never what any of them contained. */
export interface SweptBundledPackages {
  removed: string[];
  /** Left because a shipment may still publish from it, or a build came out of it. */
  kept: string[];
  /** Left because the journal has no shipment of that id, so a person decides. */
  unknown: string[];
}

const SEALED_PREFIX = 'sealed-';
const STAGING_SUFFIX = '.tmp';
const NOT_A_DIRECTORY = 'is not a directory this sweep may remove, because it is a symbolic link or not a directory at all.';

function shipmentIdOf(entry: string, prefix = ''): string | null {
  if (!entry.startsWith(prefix)) return null;
  const id = entry.slice(prefix.length);
  return isBundledShipmentId(id) ? id : null;
}

async function ownedEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * A directory the journal says nothing will read again, removed without ever
 * following a link out of the tree it was found in.
 */
async function removeSweptDirectory(root: string, entry: string): Promise<void> {
  assertOwnedVersionParent(root);
  const path = join(root, entry);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} ${NOT_A_DIRECTORY}`);
  await rm(path, { recursive: true, force: true });
}

/**
 * Removes what a finished publication has made unreadable, and answers what it
 * did by name.
 *
 * Every shipped package, every claimed copy of one and every private copy a
 * publication made holds the streaming stack's own host inputs, so a host that
 * keeps them all keeps a copy of every secret every deploy ever shipped. A
 * shipment that published or that a newer publication superseded will never be
 * read again, and only those are removed. A directory whose shipment is still
 * registered or prepared stays, because it may still publish, and one whose id
 * the journal never registered stays and is reported, because only a person can
 * say where it came from.
 */
export async function sweepBundledPackages(versionsRoot: string, journal: BundledShipmentJournal): Promise<SweptBundledPackages> {
  const swept: SweptBundledPackages = { removed: [], kept: [], unknown: [] };
  const name = (root: string, entry: string) => relative(versionsRoot, join(root, entry));

  const byShipment = async (root: string, entry: string, shipmentId: string): Promise<void> => {
    const record = await journal.find(shipmentId);
    if (!record) {
      swept.unknown.push(name(root, entry));
      return;
    }
    if (record.state !== 'published' && record.state !== 'superseded') {
      swept.kept.push(name(root, entry));
      return;
    }
    await removeSweptDirectory(root, entry);
    swept.removed.push(name(root, entry));
  };

  const packagesRoot = bundledPackagesRootFor(versionsRoot);
  for (const entry of await ownedEntries(packagesRoot)) {
    if (entry.endsWith(STAGING_SUFFIX)) continue;
    const shipmentId = shipmentIdOf(entry, SEALED_PREFIX);
    if (shipmentId) await byShipment(packagesRoot, entry, shipmentId);
  }

  const claimsRoot = bundledPackageClaimsRootFor(versionsRoot);
  for (const entry of await ownedEntries(claimsRoot)) {
    const shipmentId = shipmentIdOf(entry);
    if (shipmentId) await byShipment(claimsRoot, entry, shipmentId);
  }

  const copiesRoot = materializationsRootFor(configRootFor(versionsRoot, BUNDLED_VERSION_NAME));
  for (const entry of await ownedEntries(copiesRoot)) {
    const materializationId = shipmentIdOf(entry);
    if (!materializationId) continue;
    const record = await journal.findByMaterialization(materializationId);
    if (!record) {
      swept.unknown.push(name(copiesRoot, entry));
      continue;
    }
    // A published shipment's copy was renamed into its build, so what is left here under that id is not it.
    if (record.state !== 'superseded' || record.candidateKind !== 'new') {
      swept.kept.push(name(copiesRoot, entry));
      continue;
    }
    await removeSweptDirectory(copiesRoot, entry);
    swept.removed.push(name(copiesRoot, entry));
  }

  return swept;
}
