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

/**
 * Why a save of the manager's link would be refused, one sentence each, or
 * none. The address and the token answer to the rules a deployment's own
 * `ADMIN_API_URL` and `ADMIN_API_TOKEN` do, because that is where a new
 * deployment gets them, and no sentence repeats either.
 */
export function managerAdminLinkProblems({ url, token }: ManagerAdminLinkSave): string[] {
  const problems: string[] = [];
  if (url !== '') {
    const envProblem = settingValueProblem(ADMIN_API_URL_KEY, url);
    const problem = envProblem ? `${ADMIN_API_URL_KEY} ${envProblem}` : stackSettingFieldProblem(ADMIN_API_URL_KEY, url);
    if (problem) problems.push(problem);
  }
  if (typeof token === 'string') {
    if (url === '') {
      problems.push("A token needs the admin's address. Give the address, or leave the token out.");
    } else if (token === '') {
      problems.push('The token cannot be empty. Leave it out to keep the stored one, or clear it.');
    } else {
      const envProblem = settingValueProblem(ADMIN_API_TOKEN_KEY, token);
      const problem = envProblem ? `${ADMIN_API_TOKEN_KEY} ${envProblem}` : stackSettingFieldProblem(ADMIN_API_TOKEN_KEY, token);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}
