import type { StackContract } from '@streaming-infra-manager/common';
import { isDeepStrictEqual } from 'node:util';
import { StackVersionInUseError } from '../../src/domain/errors/StackVersionInUseError.js';
import { StackVersionRemovalHeldError } from '../../src/domain/errors/StackVersionRemovalHeldError.js';
import { assertVersionRemovable } from '../../src/domain/versions/versionRemovalGuard.js';
import { versionRemovalProblem } from '../../src/domain/versions/versionRemovalMarker.js';

import type {
  BuildOutcome,
  LegacyMetadata,
  LegacyMetadataSnapshot,
  NewStackVersion,
  PublishOutcome,
  StackVersionRecord,
  StackVersionRepository,
  StackVersionUsage,
} from '../../src/domain/versions/StackVersionRepository.js';

/**
 * The versions table without Postgres, keeping the three rules the schema and
 * the repository keep: one default at a time, a name only one row may hold, and
 * a `tested` flag that a build onto a new commit clears.
 *
 * `deployments` stands in for the profiles table, so a test can put a
 * deployment on a version and watch the removal be refused by name.
 */
export class InMemoryStackVersionRepository implements StackVersionRepository {
  private rows: StackVersionRecord[] = [];
  private nextId = 1;
  private readonly metadataRevisions = new Map<number, bigint>();
  private readonly deployments = new Map<number, string[]>();

  /** Seeds the row migration 010 inserts, so a test starts where a host does. */
  seedBundled(): StackVersionRecord {
    const bundled: StackVersionRecord = {
      id: this.nextId++,
      name: 'bundled',
      gitRef: 'main-v2',
      commitSha: null,
      status: 'ready',
      rootPath: null,
      layout: 'legacy',
      buildId: null,
      previousBuildId: null,
      contract: null,
      isDefault: true,
      tested: true,
      testedInvalidatedAt: null,
      builtAt: null,
      lastError: null,
      createdAt: new Date(0),
    };
    this.rows = [...this.rows, bundled];
    return bundled;
  }

  setDeployments(id: number, names: string[]): void {
    this.deployments.set(id, names);
  }

  /** A row as migration 015 leaves every existing one: deploying from its flat root. */
  markLegacy(id: number): void {
    this.rows = this.rows.map((row) => (row.id === id ? { ...row, layout: 'legacy', buildId: null } : row));
  }

  async list(): Promise<StackVersionUsage[]> {
    return this.rows.map((row) => ({
      ...row,
      deployments: (this.deployments.get(row.id) ?? []).length,
    }));
  }

  async findById(id: number): Promise<StackVersionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findByName(name: string): Promise<StackVersionRecord | null> {
    return this.rows.find((row) => row.name === name) ?? null;
  }

  async findDefault(): Promise<StackVersionRecord | null> {
    return this.rows.find((row) => row.isDefault) ?? null;
  }

  async insert(version: NewStackVersion): Promise<StackVersionRecord> {
    if (this.rows.some((row) => row.name === version.name)) {
      throw new Error(`duplicate stack version name: ${version.name}`);
    }

    const row: StackVersionRecord = {
      id: this.nextId++,
      name: version.name,
      gitRef: version.gitRef,
      commitSha: null,
      status: 'building',
      rootPath: version.rootPath,
      // The column's default: a row is legacy until its first publication.
      layout: 'legacy',
      buildId: null,
      previousBuildId: null,
      contract: null,
      isDefault: false,
      tested: false,
      testedInvalidatedAt: null,
      builtAt: null,
      lastError: null,
      createdAt: new Date(),
    };
    if (versionRemovalProblem(row)) throw new StackVersionRemovalHeldError(row.name, 'marker');
    this.rows = [...this.rows, row];
    return row;
  }

  async markBuilding(id: number): Promise<StackVersionRecord | null> {
    const current = this.rows.find(row => row.id === id);
    const problem = current ? versionRemovalProblem(current) : null;
    if (problem) throw new StackVersionRemovalHeldError(current!.name, 'marker');
    return this.patch(id, { status: 'building', lastError: null });
  }

  async markBuilt(
    id: number,
    outcome: BuildOutcome,
  ): Promise<StackVersionRecord | null> {
    const before = this.rows.find((row) => row.id === id);
    if (!before) return null;

    // The build outcome of the flat layout: a row marked built this way is a
    // legacy row, deploying from its flat root, as every row was before
    // migration 015.
    return this.patch(id, {
      status: 'ready',
      layout: 'legacy',
      buildId: null,
      commitSha: outcome.commitSha,
      contract: outcome.contract,
      tested: before.tested && before.commitSha === outcome.commitSha,
      testedInvalidatedAt: before.tested && before.commitSha !== outcome.commitSha
        ? before.testedInvalidatedAt ?? new Date() : before.testedInvalidatedAt,
      builtAt: new Date(),
      lastError: null,
    });
  }

  /** When set, the next publication throws after nothing was written, the way a database that went away would. */
  failNextPublish = false;

  async publish(id: number, outcome: PublishOutcome): Promise<StackVersionRecord | null> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('the database went away');
    }
    const before = this.rows.find((row) => row.id === id);
    if (!before) return null;
    const replaced = before.buildId !== null && before.buildId !== outcome.buildId;
    return this.patch(id, {
      status: 'ready',
      layout: 'builds',
      rootPath: outcome.rootPath ?? before.rootPath,
      buildId: outcome.buildId,
      previousBuildId: replaced ? before.buildId : before.previousBuildId,
      commitSha: outcome.commitSha,
      contract: outcome.contract,
      tested: before.tested && before.buildId === outcome.buildId,
      testedInvalidatedAt: before.tested && before.buildId !== outcome.buildId
        ? before.testedInvalidatedAt ?? new Date() : before.testedInvalidatedAt,
      builtAt: new Date(),
      lastError: null,
    });
  }

  async markUpdateFailed(id: number, lastError: string): Promise<StackVersionRecord | null> {
    return this.patch(id, { status: 'ready', lastError });
  }

  async markFailed(
    id: number,
    lastError: string,
  ): Promise<StackVersionRecord | null> {
    return this.patch(id, { status: 'failed', lastError });
  }

  async failInterruptedBuilds(
    lastError: string,
  ): Promise<StackVersionRecord[]> {
    const interrupted = this.rows.filter((row) => row.status === 'building');
    for (const row of interrupted) {
      const usable = row.layout === 'builds' ? row.buildId !== null : row.commitSha !== null;
      await this.patch(row.id, { status: usable ? 'ready' : 'failed', lastError });
    }
    return this.rows.filter((row) => interrupted.some((r) => r.id === row.id));
  }

  async setCommitSha(id: number, commitSha: string | null): Promise<void> {
    const before = this.rows.find((row) => row.id === id);
    if (!before) return;
    this.metadataRevisions.set(id, (this.metadataRevisions.get(id) ?? 0n) + 1n);
    await this.patch(id, {
      commitSha,
      tested: before.tested && before.commitSha === commitSha,
      testedInvalidatedAt: before.tested && before.commitSha !== commitSha
        ? before.testedInvalidatedAt ?? new Date() : before.testedInvalidatedAt,
    });
  }

  async setContract(id: number, contract: StackContract): Promise<void> {
    this.metadataRevisions.set(id, (this.metadataRevisions.get(id) ?? 0n) + 1n);
    await this.patch(id, { contract });
  }

  async captureLegacyMetadata(): Promise<LegacyMetadataSnapshot | null> {
    const version = this.rows.find(row => row.name === 'bundled' && row.layout === 'legacy');
    return version ? { version: structuredClone(version), publicationRevision: String(this.metadataRevisions.get(version.id) ?? 0n) } : null;
  }

  async refreshLegacyMetadata(expected: LegacyMetadataSnapshot, metadata: LegacyMetadata): Promise<boolean> {
    const row = this.rows.find(item => item.id === expected.version.id);
    if (!row || row.layout !== 'legacy' || !isDeepStrictEqual(row, expected.version) ||
        String(this.metadataRevisions.get(row.id) ?? 0n) !== expected.publicationRevision) return false;
    this.metadataRevisions.set(row.id, (this.metadataRevisions.get(row.id) ?? 0n) + 1n);
    await this.patch(row.id, {
      ...structuredClone(metadata),
      tested: row.tested && row.commitSha === metadata.commitSha,
      testedInvalidatedAt: row.tested && row.commitSha !== metadata.commitSha
        ? row.testedInvalidatedAt ?? new Date() : row.testedInvalidatedAt,
    });
    return true;
  }

  async setDefault(id: number): Promise<void> {
    this.rows = this.rows.map((row) => ({ ...row, isDefault: row.id === id }));
  }

  async setTested(
    id: number,
    tested: boolean,
    forCommit: string | null = null,
    forBuild: string | null = null,
  ): Promise<StackVersionRecord | null> {
    const before = this.rows.find((row) => row.id === id);
    if (!before) return null;
    const identityMatches = before.layout === 'builds'
      ? before.buildId !== null && before.buildId === forBuild
      : before.buildId === null && forBuild === null;
    if (tested && (before.status !== 'ready' || forCommit === null || before.commitSha !== forCommit || !identityMatches)) {
      return null;
    }
    return this.patch(id, { tested, testedInvalidatedAt: null });
  }

  async removeGuarded(expected: StackVersionRecord, removeOwnedFiles: (locked: StackVersionRecord) => Promise<void>): Promise<boolean> {
    const captured = structuredClone(expected);
    const current = this.rows.find(row => row.id === captured.id);
    if (!current) return false;
    assertVersionRemovable(captured, current);
    const deployments = this.deployments.get(current.id) ?? [];
    if (deployments.length) throw new StackVersionInUseError(current.name, deployments);
    await removeOwnedFiles(current);
    this.rows = this.rows.filter(row => row.id !== current.id);
    this.deployments.delete(current.id);
    return true;
  }

  async deploymentNames(id: number): Promise<string[]> {
    return this.deployments.get(id) ?? [];
  }

  private async patch(
    id: number,
    fields: Partial<StackVersionRecord>,
  ): Promise<StackVersionRecord | null> {
    const found = this.rows.find((row) => row.id === id);
    if (!found) return null;

    const updated = { ...found, ...fields };
    this.rows = this.rows.map((row) => (row.id === id ? updated : row));
    return updated;
  }
}
