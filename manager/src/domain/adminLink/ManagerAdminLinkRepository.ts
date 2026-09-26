import type { ManagerAdminLink } from '@streaming-infra-manager/common';
import type { Pool } from 'pg';

/** One write of the manager's link. Its address, or null for no default, which takes the token with it. */
export interface ManagerAdminLinkWrite {
  url: string | null;
  /** Left out keeps the stored token, null clears it, and a value replaces it. */
  token?: string | null;
}

/** Where the manager keeps its link: the database, or an in-memory one in the unit tests. */
export interface ManagerAdminLinkStore {
  read(): Promise<ManagerAdminLink>;
  /** Writes while the row is still at the revision the caller read, and answers what it holds then, or null once it had moved. */
  write(change: ManagerAdminLinkWrite, expectedRevision: number, username: string): Promise<ManagerAdminLink | null>;
  /**
   * The address and the token, read together, for Test connection alone,
   * which presents the token to the admin at that address and no other.
   * Never answered to a page.
   */
  storedLink(): Promise<StoredAdminLinkSecret>;
}

/** The manager's link with its token, as one read gives them. */
export interface StoredAdminLinkSecret {
  url: string | null;
  token: string | null;
}

interface LinkRow {
  url: string | null;
  token_stored: boolean;
  revision: number;
}

const LINK_COLUMNS = 'url, (token IS NOT NULL) AS token_stored, revision';

function linkOf(row: LinkRow): ManagerAdminLink {
  return { url: row.url, tokenStored: row.token_stored, revision: row.revision };
}

/**
 * The manager's web2 admin link in its single-row table, migration 041. A read
 * selects whether a token is stored and never the token itself, which only
 * `storedLink` reads.
 */
export class ManagerAdminLinkRepository implements ManagerAdminLinkStore {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<ManagerAdminLink> {
    const result = await this.pool.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM manager_admin_link`);
    const row = result.rows[0];
    if (!row) throw new Error('manager_admin_link has no row. Its migration inserts the one it holds.');
    return linkOf(row);
  }

  async write(change: ManagerAdminLinkWrite, expectedRevision: number, username: string): Promise<ManagerAdminLink | null> {
    const result = await this.pool.query<LinkRow>(
      `UPDATE manager_admin_link
          SET url = $1::text,
              token = CASE WHEN $1::text IS NULL THEN NULL WHEN $2::boolean THEN $3::text ELSE token END,
              revision = revision + 1,
              updated_at = NOW(),
              updated_by = $5
        WHERE singleton AND revision = $4
        RETURNING ${LINK_COLUMNS}`,
      [change.url, change.token !== undefined, change.token ?? null, expectedRevision, username],
    );
    const row = result.rows[0];
    return row ? linkOf(row) : null;
  }

  async storedLink(): Promise<StoredAdminLinkSecret> {
    const result = await this.pool.query<StoredAdminLinkSecret>('SELECT url, token FROM manager_admin_link');
    return result.rows[0] ?? { url: null, token: null };
  }
}
