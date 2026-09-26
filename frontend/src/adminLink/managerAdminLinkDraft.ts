import {
  type AdminLinkTestRequest,
  type ManagerAdminLink,
  type ManagerAdminLinkSave,
  managerAdminLinkProblems,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

/**
 * The edit in progress on the manager's own web2 admin link. The token field
 * starts empty, because no token ever reaches the page: empty keeps the
 * stored one, a value replaces it, and Clear takes it out.
 */
export interface ManagerAdminLinkDraft {
  url: string;
  token: string;
  /** Take the stored token out on save. */
  clearToken: boolean;
}

/** The draft of a link as it stands, before anything is typed. */
export function draftOf(link: ManagerAdminLink): ManagerAdminLinkDraft {
  return { url: link.url ?? '', token: '', clearToken: false };
}

/** Whether a save would change anything. */
export function managerAdminLinkChanged(link: ManagerAdminLink, draft: ManagerAdminLinkDraft): boolean {
  return draft.url !== (link.url ?? '') || draft.token !== '' || draft.clearToken;
}

/** The body of `PUT /manager-settings/admin-link` for this draft. A token left out is kept. */
export function managerAdminLinkSaveOf(link: ManagerAdminLink, draft: ManagerAdminLinkDraft): ManagerAdminLinkSave {
  const save = { expectedRevision: link.revision, url: draft.url };
  if (draft.token !== '') return { ...save, token: draft.token };
  return draft.clearToken ? { ...save, token: null } : save;
}

/**
 * Why the manager would refuse this draft, by the same shared rules, one
 * sentence each, an address on another origin than the stored token's
 * included. None repeats the address or the token.
 */
export function managerAdminLinkDraftProblems(link: ManagerAdminLink, draft: ManagerAdminLinkDraft): string[] {
  return managerAdminLinkProblems(managerAdminLinkSaveOf(link, draft), link);
}

/**
 * What Test connection sends for this draft: the typed token, else the stored
 * one, which never reaches the page and goes only to the origin it was saved
 * for. Null when there is no address, or no token to test with.
 */
export function managerAdminLinkTestOf(link: ManagerAdminLink, draft: ManagerAdminLinkDraft): AdminLinkTestRequest | null {
  if (draft.url === '') return null;
  if (draft.token !== '') return { url: draft.url, token: { source: 'typed', value: draft.token } };
  const stored = link.tokenStored && !draft.clearToken && sameAdminOrigin(draft.url, link.url ?? '');
  return stored ? { url: draft.url, token: { source: 'stored' } } : null;
}
