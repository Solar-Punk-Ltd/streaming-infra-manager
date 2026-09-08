import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BUNDLED_VERSION_NAME, parseStackContract } from '@streaming-infra-manager/common';
import type { Pool, PoolClient } from 'pg';

import { buildIdProblem } from './buildManifest.js';
import type { BundledActivation, BundledCandidateProposal, BundledShipmentRecord, PreparedBundledCandidate } from './BundledShipment.js';
import { validateBundledShipmentId, validateBundledShipmentIdentity, type BundledShipmentIdentity } from './bundledShipmentPackage.js';
import { STACK_PUBLICATION_ASSIGNMENTS } from './stackPublicationSql.js';

const SHIPMENT_COLUMNS = `shipment_id, version_id, package_digest, commit_sha, expected_publication_revision,
  root_path, state, candidate_build_id, candidate_kind, candidate_manifest, artifact_digest,
  candidate_contract, receipt_revision, published_at, created_at`;
interface ShipmentRow {
  shipment_id: string; version_id: number; package_digest: string; commit_sha: string; expected_publication_revision: string;
  root_path: string; state: BundledShipmentRecord['state']; candidate_build_id: string | null;
  candidate_kind: BundledShipmentRecord['candidateKind']; candidate_manifest: BundledShipmentRecord['candidateManifest'];
  artifact_digest: string | null; candidate_contract: BundledShipmentRecord['candidateContract'];
  receipt_revision: string | null; published_at: Date | null; created_at: Date;
}
interface LockedVersion { id: number; publication_revision: string; root_path: string | null }
function toRecord(row: ShipmentRow): BundledShipmentRecord {
  return {
    shipmentId: row.shipment_id, versionId: row.version_id, packageDigest: row.package_digest, commitSha: row.commit_sha,
    expectedRevision: row.expected_publication_revision, rootPath: row.root_path, state: row.state,
    candidateBuildId: row.candidate_build_id, candidateKind: row.candidate_kind, candidateManifest: row.candidate_manifest,
    artifactDigest: row.artifact_digest, candidateContract: row.candidate_contract, createdAt: row.created_at,
    receipt: row.state === 'published' ? {
      shipmentId: row.shipment_id, versionId: row.version_id, buildId: row.candidate_build_id!,
      publicationRevision: row.receipt_revision!, publishedAt: row.published_at!,
    } : null,
  };
}
function resolved(record: BundledShipmentRecord): BundledActivation | null {
  if (record.receipt) return { status: 'published', receipt: record.receipt };
  if (record.state === 'superseded') return { status: 'superseded', shipmentId: record.shipmentId };
  return null;
}
function candidateIdentity(record: BundledShipmentRecord) {
  return [record.candidateBuildId, record.candidateKind, record.candidateManifest, record.artifactDigest, record.candidateContract];
}

export async function readPendingShipmentBuildIds(pool: Pool, versionId: number): Promise<string[]> {
  const result = await pool.query<{ candidate_build_id: string }>(
    `SELECT DISTINCT candidate_build_id FROM bundled_shipments
     WHERE version_id = $1 AND state IN ('registered', 'prepared') AND candidate_build_id IS NOT NULL
     ORDER BY candidate_build_id`, [versionId],
  );
  return result.rows.map(row => row.candidate_build_id);
}

export class PostgresBundledShipmentRepository {
  constructor(private readonly pool: Pool, private readonly bundledRootPath: string) {
    if (!isAbsolute(bundledRootPath)) throw new Error('Bundled artifact root anchor must be absolute.');
  }

  async find(shipmentId: string): Promise<BundledShipmentRecord | null> {
    validateBundledShipmentId(shipmentId);
    const result = await this.pool.query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} FROM bundled_shipments WHERE shipment_id = $1`, [shipmentId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async register(input: BundledShipmentIdentity): Promise<BundledShipmentRecord> {
    const expected = validateBundledShipmentIdentity(input);
    if (expected.commit.length !== 40) throw new Error('Bundled publication requires a 40-character commit.');
    return this.transaction(async (client, version) => {
      const existing = await this.readLocked(client, expected.shipmentId, version.id, false);
      if (existing) {
        if (existing.versionId !== version.id || existing.packageDigest !== expected.digest || existing.commitSha !== expected.commit) {
          throw new Error('Shipment UUID already records a different identity.');
        }
        return existing;
      }
      const result = await client.query<ShipmentRow>(
        `INSERT INTO bundled_shipments (shipment_id, version_id, package_digest, commit_sha, expected_publication_revision, root_path)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SHIPMENT_COLUMNS}`,
        [expected.shipmentId, version.id, expected.digest, expected.commit, version.publication_revision, version.root_path ?? this.bundledRootPath],
      );
      return toRecord(result.rows[0]!);
    });
  }

  async reserveCandidate(shipmentId: string, proposal: BundledCandidateProposal): Promise<BundledShipmentRecord> {
    validateBundledShipmentId(shipmentId);
    if (buildIdProblem(proposal.buildId) || !['new', 'reuse'].includes(proposal.kind) ||
        proposal.manifest.buildId !== proposal.buildId || !Number.isFinite(Date.parse(proposal.manifest.builtAt)) || !proposal.manifest.toolchain?.trim()) {
      throw new Error('Invalid shipment candidate.');
    }
    const selected = structuredClone(proposal);
    return this.transaction(async (client, version) => {
      const current = (await this.readLocked(client, shipmentId, version.id))!;
      if (current.candidateBuildId) {
        if (!isDeepStrictEqual([current.candidateBuildId, current.candidateKind, current.candidateManifest], [selected.buildId, selected.kind, selected.manifest])) {
          throw new Error('Shipment candidate is already assigned.');
        }
        return current;
      }
      if (current.state !== 'registered') throw new Error('Resolved shipment cannot reserve a candidate.');
      if (current.expectedRevision !== version.publication_revision) return this.supersede(client, current);
      if (selected.manifest.commit !== current.commitSha) throw new Error('Shipment candidate commit does not match its identity.');
      if (selected.kind === 'new') {
        const owners = await client.query('SELECT 1 FROM bundled_shipments WHERE version_id = $1 AND candidate_build_id = $2 LIMIT 1', [version.id, selected.buildId]);
        if (owners.rowCount) throw new Error('Shipment candidate id is already reserved.');
      }
      const result = await client.query<ShipmentRow>(
        `UPDATE bundled_shipments SET candidate_build_id = $2, candidate_kind = $3, candidate_manifest = $4::jsonb
         WHERE shipment_id = $1 RETURNING ${SHIPMENT_COLUMNS}`,
        [shipmentId, selected.buildId, selected.kind, JSON.stringify(selected.manifest)],
      );
      return toRecord(result.rows[0]!);
    });
  }

  async markPrepared(shipmentId: string, prepared: PreparedBundledCandidate): Promise<BundledShipmentRecord> {
    validateBundledShipmentId(shipmentId);
    if (!/^[a-f0-9]{64}$/.test(prepared.artifactDigest)) throw new Error('Invalid prepared artifact digest.');
    const selected = { artifactDigest: prepared.artifactDigest, contract: parseStackContract(prepared.contract) };
    if (!selected.contract) throw new Error('Invalid prepared artifact contract.');
    return this.transaction(async (client, version) => {
      const current = (await this.readLocked(client, shipmentId, version.id))!;
      if (current.artifactDigest) {
        if (!isDeepStrictEqual([current.artifactDigest, current.candidateContract], [selected.artifactDigest, selected.contract])) {
          throw new Error('Prepared shipment identity is already assigned.');
        }
        return current;
      }
      if (current.state !== 'registered' || !current.candidateBuildId) throw new Error('Shipment has no candidate to prepare.');
      if (current.expectedRevision !== version.publication_revision) return this.supersede(client, current);
      const result = await client.query<ShipmentRow>(
        `UPDATE bundled_shipments SET state = 'prepared', artifact_digest = $2, candidate_contract = $3::jsonb
         WHERE shipment_id = $1 RETURNING ${SHIPMENT_COLUMNS}`,
        [shipmentId, selected.artifactDigest, JSON.stringify(selected.contract)],
      );
      return toRecord(result.rows[0]!);
    });
  }

  async activate(shipmentId: string, verifyCandidate: (candidate: BundledShipmentRecord) => Promise<void>): Promise<BundledActivation> {
    const snapshot = await this.find(shipmentId);
    if (!snapshot) throw new Error('Shipment was not found.');
    const previous = resolved(snapshot);
    if (previous) return previous;
    if (snapshot.state !== 'prepared') throw new Error('Shipment candidate is not prepared.');
    const revision = await this.pool.query<{ publication_revision: string }>(
      'SELECT publication_revision FROM stack_versions WHERE id = $1', [snapshot.versionId],
    );
    if (revision.rows[0]?.publication_revision !== snapshot.expectedRevision) {
      const stale = await this.transaction(async (client, version) => {
        const current = (await this.readLocked(client, shipmentId, version.id))!;
        const previous = resolved(current);
        if (previous) return previous;
        if (current.expectedRevision === version.publication_revision) return null;
        await this.supersede(client, current);
        return { status: 'superseded' as const, shipmentId };
      });
      if (stale) return stale;
    }
    try {
      // The durable candidate hold protects pruning while verification does its unbounded-by-SQL file work.
      await verifyCandidate(structuredClone(snapshot));
    } catch (error) {
      const latest = await this.find(shipmentId);
      if (latest?.receipt) return { status: 'published', receipt: latest.receipt };
      throw error;
    }
    return this.transaction(async (client, version) => {
      const current = (await this.readLocked(client, shipmentId, version.id))!;
      const previous = resolved(current);
      if (previous) return previous;
      if (current.expectedRevision !== version.publication_revision) {
        await this.supersede(client, current);
        return { status: 'superseded', shipmentId };
      }
      if (current.state !== 'prepared' || !isDeepStrictEqual(candidateIdentity(current), candidateIdentity(snapshot))) {
        throw new Error('Prepared shipment candidate changed during verification.');
      }
      const published = await client.query<{ publication_revision: string }>(
        `UPDATE stack_versions SET ${STACK_PUBLICATION_ASSIGNMENTS}
         WHERE id = $1 AND publication_revision = $6 RETURNING publication_revision`,
        [version.id, current.candidateBuildId, current.commitSha, JSON.stringify(current.candidateContract), current.rootPath, current.expectedRevision],
      );
      if (!published.rows[0]) throw new Error('Publication revision changed before activation.');
      const receipt = await client.query<ShipmentRow>(
        `UPDATE bundled_shipments SET state = 'published', receipt_revision = $2, published_at = NOW()
         WHERE shipment_id = $1 RETURNING ${SHIPMENT_COLUMNS}`,
        [shipmentId, published.rows[0].publication_revision],
      );
      return { status: 'published', receipt: toRecord(receipt.rows[0]!).receipt! };
    });
  }

  async pendingBuildIds(versionId: number): Promise<string[]> {
    return readPendingShipmentBuildIds(this.pool, versionId);
  }

  private async supersede(client: PoolClient, record: BundledShipmentRecord): Promise<BundledShipmentRecord> {
    const result = await client.query<ShipmentRow>(
      `UPDATE bundled_shipments SET state = 'superseded' WHERE shipment_id = $1 RETURNING ${SHIPMENT_COLUMNS}`, [record.shipmentId],
    );
    return toRecord(result.rows[0]!);
  }

  private async readLocked(client: PoolClient, shipmentId: string, versionId: number, required = true): Promise<BundledShipmentRecord | null> {
    const result = await client.query<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} FROM bundled_shipments WHERE shipment_id = $1 FOR UPDATE`, [shipmentId]);
    if (!result.rows[0] && required) throw new Error('Shipment was not found.');
    if (result.rows[0] && result.rows[0].version_id !== versionId) throw new Error('Shipment identity belongs to another version.');
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  private async transaction<T>(work: (client: PoolClient, version: LockedVersion) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<LockedVersion>('SELECT id, publication_revision, root_path FROM stack_versions WHERE name = $1 FOR UPDATE', [BUNDLED_VERSION_NAME]);
      if (!result.rows[0]) throw new Error('Bundled version was not found.');
      const outcome = await work(client, result.rows[0]);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
