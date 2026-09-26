/**
 * The link from a deployment's stream uploader to the web2 admin, the separate
 * service where streams are declared and listed.
 *
 * The stack reads it from two settings. `ADMIN_API_URL` alone turns the
 * uploader's admin mode on, and in admin mode the uploader refuses to start
 * without `ADMIN_API_TOKEN` of at least 32 characters
 * (`packages/stream-uploader/src/utils/config.ts` and `libs/AdminApiClient.ts`
 * in swarm-hls-stream). The manager and the page hold a setting of the two to
 * the same rule, so neither stores one the uploader would refuse.
 */

export const ADMIN_API_URL_KEY = 'ADMIN_API_URL';

export const ADMIN_API_TOKEN_KEY = 'ADMIN_API_TOKEN';

/** The stream uploader's own floor for the token, `MIN_ADMIN_API_TOKEN_LENGTH`. */
export const ADMIN_API_TOKEN_MIN_LENGTH = 32;

/** What the two keys come to once a save or a create lands, as far as the rule needs them. */
export interface AdminLinkState {
  /** The address the uploader is given, empty when admin mode is off. */
  url: string;
  /** Whether the uploader is given a token that is not empty, from wherever it comes. */
  hasToken: boolean;
}

/**
 * What the two keys come to before a save or a create changes them, and what a
 * reset of each puts back, which is what the version gives the deployment.
 */
export interface AdminLinkBefore {
  url: { current: string; afterReset: string };
  /** Whether a token that is not empty is there now, and whether one still is once a value stored for it is reset. */
  token: { current: boolean; afterReset: boolean };
}

/** One key of a save or a create: a value, or null to go back to what the version gives. */
interface AdminLinkEdit {
  key: string;
  value: string | null;
}

/**
 * Why the uploader would refuse to start with these two, naming both keys, or
 * null. An empty address leaves the uploader standalone, whatever the token.
 */
export function adminLinkProblem({ url, hasToken }: AdminLinkState): string | null {
  if (url === '' || hasToken) return null;
  return `${ADMIN_API_URL_KEY} is set and ${ADMIN_API_TOKEN_KEY} is not, and the stream uploader refuses to start that way. Set ${ADMIN_API_TOKEN_KEY}, or leave ${ADMIN_API_URL_KEY} empty.`;
}

/** Whether the edits name either key, which is when a save or a create is held to the rule. */
export function editsAdminLink(edits: readonly AdminLinkEdit[]): boolean {
  return edits.some(({ key }) => key === ADMIN_API_URL_KEY || key === ADMIN_API_TOKEN_KEY);
}

/** What the two keys come to once the edits land on what was there before. */
export function adminLinkAfterEdits(edits: readonly AdminLinkEdit[], before: AdminLinkBefore): AdminLinkState {
  const edited = (key: string): AdminLinkEdit | undefined => edits.find((edit) => edit.key === key);
  const urlEdit = edited(ADMIN_API_URL_KEY);
  const tokenEdit = edited(ADMIN_API_TOKEN_KEY);
  const url = urlEdit === undefined ? before.url.current : (urlEdit.value ?? before.url.afterReset);
  const hasToken =
    tokenEdit === undefined
      ? before.token.current
      : tokenEdit.value === null
        ? before.token.afterReset
        : tokenEdit.value !== '';
  return { url, hasToken };
}

/**
 * Why the rule refuses what these edits leave, or null. Edits that name
 * neither key are not held to it, so a deployment whose version already
 * breaks the rule can still have its other settings saved.
 */
export function adminLinkEditProblem(edits: readonly AdminLinkEdit[], before: AdminLinkBefore): string | null {
  if (!editsAdminLink(edits)) return null;
  return adminLinkProblem(adminLinkAfterEdits(edits, before));
}
