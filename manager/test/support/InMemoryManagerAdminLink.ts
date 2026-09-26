import type { ManagerAdminLink } from '@streaming-infra-manager/common';

import type { ManagerAdminLinkStore, ManagerAdminLinkWrite } from '../../src/domain/adminLink/ManagerAdminLinkRepository.js';

/** The manager's web2 admin link as its single-row table holds it, in memory, with the table's revision guard. */
export class InMemoryManagerAdminLink implements ManagerAdminLinkStore {
  url: string | null = null;
  token: string | null = null;
  revision = 0;
  updatedBy: string | null = null;

  async read(): Promise<ManagerAdminLink> {
    return { url: this.url, tokenStored: this.token !== null, revision: this.revision };
  }

  async write(change: ManagerAdminLinkWrite, expectedRevision: number, username: string): Promise<ManagerAdminLink | null> {
    if (expectedRevision !== this.revision) return null;
    this.url = change.url;
    if (change.url === null) this.token = null;
    else if (change.token !== undefined) this.token = change.token;
    this.revision += 1;
    this.updatedBy = username;
    return this.read();
  }

  async storedToken(): Promise<string | null> {
    return this.token;
  }
}
