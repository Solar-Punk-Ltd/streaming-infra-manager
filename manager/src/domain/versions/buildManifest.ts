import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildTreeSharing } from './buildTreeClone.js';

/** Written by the build script into every build, with the commit and how it was built. */
export const BUILD_MANIFEST_FILE = '.stack-manifest.json';

/** Written last, by the build script, once everything else in the build is in place. */
export const BUILD_COMPLETE_MARKER = '.complete';

const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const BUILD_ID_RE = /^[0-9a-f]{7,40}(-r[1-9][0-9]*)?$/;

export interface BuildManifest {
  commit: string;
  /** The commit, or `<commit>-r<n>` for a forced rebuild of one. */
  buildId: string;
  /** ISO time. */
  builtAt: string;
  /** The image and the package manager the build ran with. */
  toolchain: string;
  /** The generation of the host configuration copied into the build, and its hashes. Absent on a build an older manager wrote. */
  inputGeneration?: number;
  inputHashes?: Record<string, string>;
  /**
   * How the unchanged files of a build made by applying settings reached it:
   * hard linked to the build it was made from, or copied because the
   * filesystem refused a link. Absent on a build the build script wrote.
   */
  treeSharing?: BuildTreeSharing;
}

export type BuildManifestRead =
  | { manifest: BuildManifest; problem: null }
  | { manifest: null; problem: string };

/** Why a string is not a build id, or null. A build id is one path segment under the builds root. */
export function buildIdProblem(id: string): string | null {
  if (BUILD_ID_RE.test(id)) return null;
  return `${JSON.stringify(id)} is not a build id: a commit of 7 to 40 hex digits, or that with -r<n> for a forced rebuild.`;
}

function fieldProblem(raw: Record<string, unknown>): string | null {
  const commit = raw.commit;
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    return 'its commit is not a commit sha';
  }
  const buildId = raw.buildId;
  if (typeof buildId !== 'string' || buildIdProblem(buildId)) {
    return 'its buildId is not a build id';
  }
  const builtAt = raw.builtAt;
  if (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt))) {
    return 'its builtAt is not a time';
  }
  if (typeof raw.toolchain !== 'string' || raw.toolchain.trim() === '') {
    return 'its toolchain is empty';
  }
  return null;
}

/**
 * What a build directory says about itself, or why it is not a build the
 * manager may deploy from. Read from the directory itself: a manifest in a
 * parent says nothing about a child.
 */
export function readBuildManifest(dir: string): BuildManifestRead {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { manifest: null, problem: `${dir} does not exist.` };
  }
  if (!existsSync(join(dir, BUILD_COMPLETE_MARKER))) {
    return {
      manifest: null,
      problem: `${dir} has no ${BUILD_COMPLETE_MARKER} marker, so its build did not finish.`,
    };
  }
  const manifestPath = join(dir, BUILD_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { manifest: null, problem: `${dir} has no ${BUILD_MANIFEST_FILE}.` };
  }
  let bytes: string;
  try {
    bytes = readFileSync(manifestPath, 'utf8');
  } catch {
    return { manifest: null, problem: `${manifestPath} does not parse as JSON.` };
  }
  return parseBuildManifestBytes(bytes, manifestPath);
}

/** Parse bytes already captured by a caller without reopening their source path. */
export function parseBuildManifestBytes(bytes: string | Buffer, manifestPath = BUILD_MANIFEST_FILE): BuildManifestRead {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString());
  } catch {
    return { manifest: null, problem: `${manifestPath} does not parse as JSON.` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, problem: `${manifestPath} does not parse as a manifest object.` };
  }
  const record = raw as Record<string, unknown>;
  const problem = fieldProblem(record);
  if (problem) return { manifest: null, problem: `${manifestPath}: ${problem}.` };
  return {
    manifest: {
      commit: record.commit as string,
      buildId: record.buildId as string,
      builtAt: record.builtAt as string,
      toolchain: record.toolchain as string,
      ...(Number.isInteger(record.inputGeneration) ? { inputGeneration: record.inputGeneration as number } : {}),
      ...(typeof record.inputHashes === 'object' && record.inputHashes !== null
        ? { inputHashes: record.inputHashes as Record<string, string> }
        : {}),
      ...(record.treeSharing === 'linked' || record.treeSharing === 'copied'
        ? { treeSharing: record.treeSharing }
        : {}),
    },
    problem: null,
  };
}
