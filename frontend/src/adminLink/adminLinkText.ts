import type { AdminLinkTestOutcome } from '@streaming-infra-manager/common';

/**
 * Everything the web2 admin link says in words, wherever it is set: the
 * Manager settings page, the new-deployment wizard and a deployment's Stack
 * settings card. Each sentence is pinned by a test.
 */

/** One plain sentence for each outcome of Test connection. */
const TEST_TEXT: Readonly<Record<AdminLinkTestOutcome, string>> = {
  linked: "Linked: the web2 admin took the token and signs its catalog with this deployment's stream address.",
  'token-accepted': 'The web2 admin answered and took the token.',
  'owner-unconfirmed':
    "The web2 admin took the token but did not say which address it signs with, so this deployment's stream key could not be compared.",
  'owner-mismatch':
    "The web2 admin took the token but signs its catalog with another address than this deployment's stream key, so the uploader will refuse to start.",
  'stored-token-elsewhere':
    "The manager's stored token was saved for another address, so it was not sent here, and only a token typed for this address can be tested.",
  'token-refused': 'The web2 admin answered but refused the token.',
  'not-admin': 'Something answered at this address, but not the way a web2 admin does.',
  redirected: 'This address answered with a redirect, so give the address the web2 admin itself answers on.',
  unreachable: 'The web2 admin did not answer from where the manager runs.',
  'invalid-address': 'This is not an http or https address the uploader can use.',
  'not-linked': 'This deployment is not linked to a web2 admin, because ADMIN_API_URL is empty.',
  'no-token': 'There is no token to test with, and the uploader refuses to start with an address and no token.',
};

export function adminLinkTestText(outcome: AdminLinkTestOutcome): string {
  return TEST_TEXT[outcome];
}

export type AdminLinkTestSeverity = 'success' | 'info' | 'warning' | 'error';

const QUIET: readonly AdminLinkTestOutcome[] = ['linked', 'token-accepted'];

/** How loudly the page says an outcome: a link that works quietly, an owner not compared as a caution, anything the uploader would fail on as an error. */
export function adminLinkTestSeverity(outcome: AdminLinkTestOutcome): AdminLinkTestSeverity {
  if (QUIET.includes(outcome)) return 'success';
  if (outcome === 'not-linked') return 'info';
  if (outcome === 'owner-unconfirmed') return 'warning';
  return 'error';
}

/** Said beside every Test connection button. */
export const ADMIN_LINK_TEST_REACH =
  "The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here.";

/** The switch of the new-deployment wizard's Web2 admin group. */
export const ADMIN_LINK_SWITCH_LABEL = 'Link this deployment to the web2 admin';

/** The line at the top of the wizard's Web2 admin group. */
export const ADMIN_LINK_GROUP_LEAD =
  "Where this deployment's stream uploader reports its streams. It starts from the link on Manager settings.";

/** Said under the switch while it is off. */
export const ADMIN_LINK_OFF_NOTE =
  'Off, this deployment stores an empty ADMIN_API_URL, so its uploader runs standalone even when its version turns admin mode on.';

/** Said in place of the group for a version whose settings declare no web2 admin link. */
export const ADMIN_LINK_ABSENT = 'This version takes no web2 admin link, so the uploader runs standalone.';

/** Said in place of the group when the version's settings could not be read. */
export const ADMIN_LINK_UNREAD =
  "This version's settings could not be read, so the deployment starts with the manager's link where its version takes one, and otherwise keeps what its version sets.";

/** What the choice of the manager's stored token says, which depends on whether it has one. */
export function storedTokenDetail(stored: boolean): string {
  return stored
    ? 'The manager copies it into this deployment when it is created. It never reaches this page.'
    : 'The manager stores no token. Save one on Manager settings, or type one here.';
}

/** Said in the wizard's group when the address leaves the origin the manager's stored token was saved for. */
export const STORED_TOKEN_ELSEWHERE =
  "The manager's stored token was saved for another address, and the manager sends it only there. Type the token for this address.";

/** The button beside that sentence, which moves to a token typed here. */
export const TYPE_TOKEN_HERE = 'Type a token for this address';

/** The line at the top of the Manager settings card. */
export const MANAGER_LINK_LEAD =
  'New uploader deployments start linked to this web2 admin, with the switch on in the new-deployment wizard. A deployment keeps what it was created with, so a change here reaches only deployments created after it.';

export const MANAGER_LINK_URL_HINT =
  'Where the uploaders reach the web2 admin. Leave it empty for no default, which takes the stored token out too.';

export const MANAGER_LINK_SAVED = 'Saved. New uploader deployments start with this link.';

export const MANAGER_LINK_SAVE_RACE =
  'The link changed elsewhere after this page read it, so nothing was saved. The page has read it again. Make your change again.';

/** Where the manager's token stands, in place of the token, which is never shown. */
export function managerTokenStatus(stored: boolean, clearing: boolean): string {
  if (clearing) return 'The stored token is taken out when you save.';
  return stored ? 'A token is stored. It is never shown.' : 'No token is stored.';
}

/** The line under the manager's token field. */
export function managerTokenHint(stored: boolean): string {
  const what = "The web2 admin's INTERNAL_API_TOKEN, at least 32 characters.";
  return stored ? `${what} Leave it empty to keep the stored one.` : what;
}

/** Why the Manager settings card cannot test yet. */
export function managerLinkTestBlocked(facts: { problems: boolean; url: boolean; tokenStored: boolean }): string {
  if (facts.problems) return 'Fix the address or the token above to test it.';
  if (!facts.url) return 'Type the address to test it.';
  return facts.tokenStored ? 'Type a token, or keep the stored one, to test it.' : 'Type a token to test it.';
}
