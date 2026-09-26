import { ADMIN_API_TOKEN_KEY, ADMIN_API_URL_KEY, sameAdminOrigin } from './adminLink.js';
import { settingValueProblem } from './settingValues.js';
import { stackSettingFieldProblem } from './stackSettingFields.js';

/**
 * The web2 admin link every new uploader deployment starts with, set once for
 * the whole manager on its Manager settings page. It applies to deployments
 * created after it is set and never to one that exists, which keeps what it
 * was created with in its own settings.
 */

/** What `GET /manager-settings/admin-link` answers. The token is never answered, only whether one is stored. */
export interface ManagerAdminLink {
  /** The admin's address, or null for no default, which starts new deployments standalone. */
  url: string | null;
  tokenStored: boolean;
  /** The revision a save names. A save is refused once another one has moved past it. */
  revision: number;
}

/** What `PUT /manager-settings/admin-link` takes. */
export interface ManagerAdminLinkSave {
  expectedRevision: number;
  /** The admin's address, or empty for no default, which takes the stored token with it. */
  url: string;
  /** Left out keeps the stored token, null clears it, and a value replaces it. */
  token?: string | null;
}

/** Why this key cannot hold this value as a deployment's settings would take it, or null. Never repeats the value. */
function keyValueProblem(key: string, value: string): string | null {
  const envProblem = settingValueProblem(key, value);
  return envProblem ? `${key} ${envProblem}` : stackSettingFieldProblem(key, value);
}

/** Why a new deployment's `ADMIN_API_URL` could not be this address, or null. */
export function adminUrlProblem(url: string): string | null {
  return keyValueProblem(ADMIN_API_URL_KEY, url);
}

/** Why a new deployment's `ADMIN_API_TOKEN` could not be this token, or null. */
export function adminTokenProblem(token: string): string | null {
  return keyValueProblem(ADMIN_API_TOKEN_KEY, token);
}

/** The link a save lands on: its address, or null for none, and whether it stores a token. */
export type StoredManagerAdminLink = Pick<ManagerAdminLink, 'url' | 'tokenStored'>;

/**
 * Why a save of the manager's link would be refused, one sentence each, or
 * none. The address and the token answer to the rules a deployment's own
 * `ADMIN_API_URL` and `ADMIN_API_TOKEN` do, because that is where a new
 * deployment gets them, and no sentence repeats either. An address on
 * another origin than the stored link's has to come with a new token or a
 * cleared one, because the stored token goes only to the address it was saved
 * with.
 */
export function managerAdminLinkProblems({ url, token }: ManagerAdminLinkSave, stored?: StoredManagerAdminLink): string[] {
  const problems: string[] = [];
  const urlProblem = url === '' ? null : adminUrlProblem(url);
  if (urlProblem) problems.push(urlProblem);
  if (stored?.tokenStored && url !== '' && token === undefined && !sameAdminOrigin(url, stored.url ?? '')) {
    problems.push(
      'The address moves to another one than the stored token was saved with, and the manager sends its stored token only to the address it was saved with. Type the token again for the new address, or clear it.',
    );
  }
  if (typeof token === 'string') {
    const tokenProblem =
      url === ''
        ? "A token needs the admin's address. Give the address, or leave the token out."
        : token === ''
          ? 'The token cannot be empty. Leave it out to keep the stored one, or clear it.'
          : adminTokenProblem(token);
    if (tokenProblem) problems.push(tokenProblem);
  }
  return problems;
}
