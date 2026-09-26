import { type ManagerAdminLink, type ManagerAdminLinkSave, managerAdminLinkProblems } from '@streaming-infra-manager/common';

import { AdminLinkInputError, ManagerSettingsChangedError } from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { ManagerAdminLinkStore, ManagerAdminLinkWrite } from './ManagerAdminLinkRepository.js';

const logger = Logger.getInstance();

/** A save as the store takes it: an empty address is no default, which takes the token with it. */
function writeOf(save: ManagerAdminLinkSave): ManagerAdminLinkWrite {
  if (save.url === '') return { url: null };
  return save.token === undefined ? { url: save.url } : { url: save.url, token: save.token };
}

/** What the log says a save did, which never names the address or the token. */
function describeSave(save: ManagerAdminLinkSave): string {
  if (save.url === '') return 'removed the web2 admin link for new deployments';
  const token = save.token === undefined ? 'kept its token' : save.token === null ? 'cleared its token' : 'replaced its token';
  return `set the web2 admin link for new deployments and ${token}`;
}

/**
 * The web2 admin link every new uploader deployment starts with, which the
 * Manager settings page reads and saves. The token is never answered, only
 * whether one is stored.
 */
export class ManagerAdminLinkService {
  constructor(private readonly store: ManagerAdminLinkStore) {}

  read(): Promise<ManagerAdminLink> {
    return this.store.read();
  }

  /** Stores one save, or refuses all of it, and answers the link as it stands after. */
  async save(save: ManagerAdminLinkSave, username: string): Promise<ManagerAdminLink> {
    const problems = managerAdminLinkProblems(save);
    if (problems.length > 0) throw new AdminLinkInputError(problems);
    const saved = await this.store.write(writeOf(save), save.expectedRevision, username);
    if (!saved) throw new ManagerSettingsChangedError();
    logger.info(`[AdminLink] ${username} ${describeSave(save)}, now at revision ${saved.revision}`);
    return saved;
  }
}
