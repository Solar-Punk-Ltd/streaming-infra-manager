import { ADMIN_API_TOKEN_KEY, ADMIN_API_URL_KEY } from './adminLink.js';
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

/**
 * Why a save of the manager's link would be refused, one sentence each, or
 * none. The address and the token answer to the rules a deployment's own
 * `ADMIN_API_URL` and `ADMIN_API_TOKEN` do, because that is where a new
 * deployment gets them, and no sentence repeats either.
 */
export function managerAdminLinkProblems({ url, token }: ManagerAdminLinkSave): string[] {
  const problems: string[] = [];
  const urlProblem = url === '' ? null : adminUrlProblem(url);
  if (urlProblem) problems.push(urlProblem);
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
