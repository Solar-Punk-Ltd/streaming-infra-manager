import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureBundledInputs, exportPinnedBundledSource } from '../domain/versions/bundledSourceCapture.js';
import { sealBundledPackage, validateBundledShipmentId } from '../domain/versions/bundledShipmentPackage.js';
import { adoptHostConfig, readHostConfigRevision } from '../domain/versions/hostConfigCapture.js';
import { assertOwnedDirectory, assertRelativeTreePath, assertSeparateOwnedTrees } from '../domain/versions/ownedTreePaths.js';
import { CLI_PREFIX, type CommandStreams } from './commandStreams.js';
import { parseFlags, withUsage } from './flags.js';
import { assertToolchain, TOOLCHAIN_FLAG } from './toolchain.js';

export const BUNDLED_SEAL = 'bundled:seal';

const SOURCE = '--source';
const OUT = '--out';
const SHIPMENT_ID = '--shipment-id';
const DIST = '--dist';
const ADOPT_INPUTS = '--adopt-inputs';

/** The working tree the export goes into, removed once the package is sealed. */
const EXPORT_DIR = 'export';
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

export const BUNDLED_SEAL_USAGE = [
  'Usage:',
  `  node dist/cli.js ${BUNDLED_SEAL} ${SOURCE} <checkout> ${OUT} <directory outside it>`,
  `      ${SHIPMENT_ID} <uuid> ${DIST} <built directory> [${DIST} ...]`,
  `      ${TOOLCHAIN_FLAG} <text> [${ADOPT_INPUTS}]`,
  '',
  'Turns the checked out streaming stack into one sealed package the host can',
  'verify byte for byte. The files come from the commit the checkout is on, so',
  'an uncommitted change to the application is refused. The built directories',
  `named by ${DIST} are added because they are not committed, and the host`,
  `inputs of the checkout travel with it. ${ADOPT_INPUTS} commits the input`,
  'files the checkout has now as generation one, for a checkout that never had',
  'a committed revision of them.',
  '',
  'Prints one line of JSON on standard output with the identity of the package:',
  'its shipment id, the commit it was taken from, its digest and where it is.',
].join('\n');

async function makeOwnedDirectory(root: string, path: string): Promise<void> {
  try {
    await mkdir(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertOwnedDirectory(root, path);
}

async function copyOwnedTree(source: string, destination: string, path: string): Promise<void> {
  await assertOwnedDirectory(source, path);
  await makeOwnedDirectory(destination, path);
  for (const name of (await readdir(join(source, path))).sort()) {
    const child = `${path}/${name}`;
    assertRelativeTreePath(child);
    const info = await lstat(join(source, child));
    if (info.isDirectory()) {
      await copyOwnedTree(source, destination, child);
    } else if (info.isFile()) {
      await writeFile(join(destination, child), await readFile(join(source, child)),
        { flag: 'wx', mode: info.mode & 0o111 ? EXECUTABLE_MODE : FILE_MODE });
    } else {
      throw new Error(`${child} is neither a regular file nor a directory, so it cannot be packaged.`);
    }
  }
}

async function addBuiltDirectory(source: string, exported: string, path: string, buildCommand: string): Promise<void> {
  assertRelativeTreePath(path);
  try {
    await assertOwnedDirectory(source, path);
  } catch {
    throw new Error(`${path} is not a directory in ${source}. Build the stack first with "${buildCommand}".`);
  }
  const parents = path.split('/').slice(0, -1);
  for (let index = 0; index < parents.length; index += 1) {
    await makeOwnedDirectory(exported, parents.slice(0, index + 1).join('/'));
  }
  await copyOwnedTree(source, exported, path);
}

/**
 * Seals one shipment of the bundled streaming stack, on the machine the
 * deploy runs from. It opens no database, so it runs on a laptop.
 */
export async function runBundledSeal(argv: readonly string[], streams: CommandStreams): Promise<void> {
  const { source, out, shipmentId, built, adoptInputs } = withUsage(BUNDLED_SEAL_USAGE, () => {
    const flags = parseFlags(argv, { valued: [SOURCE, OUT, SHIPMENT_ID, TOOLCHAIN_FLAG], repeated: [DIST], switches: [ADOPT_INPUTS] });
    const selected = {
      source: flags.required(SOURCE),
      out: flags.required(OUT),
      shipmentId: validateBundledShipmentId(flags.required(SHIPMENT_ID)),
      built: flags.list(DIST),
      adoptInputs: flags.has(ADOPT_INPUTS),
    };
    assertToolchain(flags.required(TOOLCHAIN_FLAG));
    if (selected.built.length === 0) throw new Error(`${DIST} names a built directory to ship and is needed at least once.`);
    return selected;
  });

  try {
    await assertSeparateOwnedTrees(source, out);
  } catch {
    throw new Error(`${OUT} must name a directory outside the checkout given by ${SOURCE}.`);
  }

  await mkdir(out, { recursive: true });
  const exported = join(out, EXPORT_DIR);
  const pinned = await exportPinnedBundledSource(source, exported);
  try {
    for (const path of built) await addBuiltDirectory(source, exported, path, `pnpm -C ${source} -r build`);
    if (!(await readHostConfigRevision(source))) {
      if (!adoptInputs) {
        throw new Error(`${source} has no committed revision of its host inputs. Pass ${ADOPT_INPUTS} to commit the ones it has now as generation one.`);
      }
      const adopted = await adoptHostConfig(source);
      if (adopted) {
        streams.err(`${CLI_PREFIX} adopted the host inputs of ${source} as generation ${adopted.generation}: ${Object.keys(adopted.files).sort().join(', ')}`);
      }
    }
    const inputs = await captureBundledInputs(source, exported);
    const sealed = await sealBundledPackage(exported, join(out, `sealed-${shipmentId}`), { shipmentId, commit: pinned.commit, inputs });
    await rm(exported, { recursive: true, force: true });
    streams.out(JSON.stringify({ shipmentId, commit: sealed.identity.commit, digest: sealed.identity.digest, path: sealed.root }));
  } catch (error) {
    await rm(exported, { recursive: true, force: true });
    throw error;
  }
}
