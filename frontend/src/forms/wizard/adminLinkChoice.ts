import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  type AdminLinkTestRequest,
  type AdminLinkTokenChoice,
  addressOfStreamKey,
  adminTokenProblem,
  adminUrlProblem,
  type DeploymentSettingEntry,
  type ManagerAdminLink,
  type NewDeploymentSetting,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

import { ADMIN_LINK_ABSENT, ADMIN_LINK_MANAGER_UNREAD, ADMIN_LINK_UNREAD } from '../../adminLink/adminLinkText';
import { chosenKey, needsStreamKey, type WizardContext, type WizardState } from './wizardState';

/**
 * The new-deployment wizard's Web2 admin group: whether the deployment's
 * stream uploader reports to the web2 admin, where, and with which token.
 *
 * It starts from the manager's own link, set on the Manager settings page,
 * and keeps the operator's choice once they touch it. The manager's stored
 * token never reaches the page: the create only says to use it, and the
 * manager copies it into the deployment as it is inserted.
 */
export interface AdminLinkChoice {
  /** Whether the uploader reports to the web2 admin. Off, it runs standalone whatever its version sets. */
  on: boolean;
  url: string;
  tokenSource: 'stored' | 'typed';
  /** The token typed here, used when `tokenSource` is `typed`. */
  token: string;
}

const PREFIX = 'Web2 admin: ';

/** Whether the deployment runs a stream uploader, which is what reports to the web2 admin. */
export function asksAdminLink(state: WizardState): boolean {
  return needsStreamKey(state);
}

/** Where the group starts: on at the manager's own address when it has one, with its token when it stores one, and off otherwise. */
function defaultChoiceOf(link: ManagerAdminLink | null | undefined): AdminLinkChoice {
  return { on: Boolean(link?.url), url: link?.url ?? '', tokenSource: link?.tokenStored ? 'stored' : 'typed', token: '' };
}

/** The choice on screen: the operator's once they touched the group, the manager's own link until then. */
export function chosenAdminLink(state: WizardState, context: WizardContext): AdminLinkChoice {
  return state.adminLink ?? defaultChoiceOf(context.managerAdminLink);
}

/**
 * Whether the group still waits for the manager's own link, or could not
 * read it, while the operator has not touched it. A read that failed leaves
 * the link to the manager, which adds its own to a create that names neither
 * key, so the create does not store an empty address in its place.
 */
export function managerLinkPending(state: WizardState, context: WizardContext): 'reading' | 'failed' | null {
  if (state.adminLink) return null;
  const status = context.managerAdminLinkStatus ?? 'read';
  return status === 'read' ? null : status;
}

/**
 * Whether the settings list read for the choices on screen lets a create set
 * both keys: `reading` until it arrives, `unread` when it could not be read or
 * nothing asked for one, and `absent` for a version that declares no web2
 * admin link.
 */
export type AdminLinkAvailability = 'available' | 'reading' | 'unread' | 'absent';

function settable(entries: readonly DeploymentSettingEntry[], key: string): boolean {
  return entries.some((entry) => entry.key === key && entry.declared && entry.owner === null);
}

/** Whether a list lets a create set both keys, which is what the group sets them through. */
function takesAdminLink(entries: readonly DeploymentSettingEntry[]): boolean {
  return settable(entries, ADMIN_API_URL_KEY) && settable(entries, ADMIN_API_TOKEN_KEY);
}

export function adminLinkAvailability(context: WizardContext): AdminLinkAvailability {
  const load = context.newDeploymentSettings;
  if (!load || load.failure) return 'unread';
  if (!load.catalog) return 'reading';
  return takesAdminLink(load.catalog.entries) ? 'available' : 'absent';
}

/**
 * Whether the group asks for the manager's stored token for an address on
 * another origin than the one it was saved for, where the manager refuses to
 * send it and a token typed for the address has to take its place.
 */
export function storedTokenElsewhere(state: WizardState, context: WizardContext): boolean {
  const choice = chosenAdminLink(state, context);
  const link = context.managerAdminLink;
  if (!choice.on || choice.tokenSource !== 'stored' || !link?.tokenStored) return false;
  return urlProblemOf(choice) === null && !sameAdminOrigin(choice.url, link.url ?? '');
}

/** The token a test or a create presents, or why there is none to present. */
function tokenOf(choice: AdminLinkChoice, context: WizardContext): { token: AdminLinkTokenChoice } | { problem: string } {
  if (choice.tokenSource === 'stored') {
    const link = context.managerAdminLink;
    if (!link?.tokenStored) return { problem: 'the manager stores no token, so type one here' };
    return sameAdminOrigin(choice.url, link.url ?? '')
      ? { token: { source: 'stored' } }
      : { problem: "the manager's stored token was saved for another address, so type the token for this one" };
  }
  if (choice.token === '') return { problem: "type the token, or use the manager's stored one" };
  const problem = adminTokenProblem(choice.token);
  return problem ? { problem } : { token: { source: 'typed', value: choice.token } };
}

/** Why the address cannot be used, or null. */
function urlProblemOf(choice: AdminLinkChoice): string | null {
  return choice.url === '' ? 'type the address, or switch the link off' : adminUrlProblem(choice.url);
}

/** What stops Continue on the settings step and Deploy on the review, or null. */
export function adminLinkError(state: WizardState, context: WizardContext): string | null {
  if (!asksAdminLink(state)) return null;
  const availability = adminLinkAvailability(context);
  if (availability === 'reading') return `${PREFIX}reading this version's settings`;
  if (availability !== 'available') return null;
  const pending = managerLinkPending(state, context);
  if (pending === 'reading') return `${PREFIX}reading the manager's link`;
  if (pending === 'failed') return null;
  const choice = chosenAdminLink(state, context);
  if (!choice.on) return null;
  const urlProblem = urlProblemOf(choice);
  if (urlProblem) return `${PREFIX}${urlProblem}`;
  const token = tokenOf(choice, context);
  return 'problem' in token ? `${PREFIX}${token.problem}` : null;
}

/** What the create body carries for the link: its keys among the stack settings, and whether the manager copies its stored token in. */
export interface AdminLinkBody {
  settings: NewDeploymentSetting[];
  useManagerToken: boolean;
}

const NOTHING: AdminLinkBody = { settings: [], useManagerToken: false };

/**
 * The link as the create sends it. Off is an explicit empty address, which
 * the deployment stores, so its uploader runs standalone even when its
 * version turns admin mode on. Nothing is sent for a deployment that runs no
 * uploader, for a version whose list takes no link or could not be read, and
 * for a group left alone while the manager's link could not be read. The
 * manager then adds its own link where the version takes one.
 */
export function adminLinkBody(state: WizardState, context: WizardContext): AdminLinkBody {
  if (!asksAdminLink(state) || adminLinkAvailability(context) !== 'available') return NOTHING;
  if (managerLinkPending(state, context) !== null) return NOTHING;
  const choice = chosenAdminLink(state, context);
  if (!choice.on) return { settings: [{ key: ADMIN_API_URL_KEY, value: '' }], useManagerToken: false };
  const url = { key: ADMIN_API_URL_KEY, value: choice.url };
  return choice.tokenSource === 'stored'
    ? { settings: [url], useManagerToken: true }
    : { settings: [url, { key: ADMIN_API_TOKEN_KEY, value: choice.token }], useManagerToken: false };
}

/**
 * What Test connection asks from the group, with the address of the stream key
 * chosen here as the owner to compare, or null until the address and the token
 * can be used.
 */
export function adminLinkTestOf(state: WizardState, context: WizardContext): AdminLinkTestRequest | null {
  const choice = chosenAdminLink(state, context);
  if (!choice.on || urlProblemOf(choice) !== null) return null;
  const token = tokenOf(choice, context);
  if ('problem' in token) return null;
  return { url: choice.url, token: token.token, feedOwner: addressOfStreamKey(chosenKey(state)) ?? null };
}

/** The review's line for the link, naming the address and where the token comes from, never the token. Null where the group asks nothing. */
export function adminLinkSummary(state: WizardState, context: WizardContext): string | null {
  if (!asksAdminLink(state)) return null;
  const availability = adminLinkAvailability(context);
  if (availability === 'absent') return ADMIN_LINK_ABSENT;
  if (availability === 'unread') return ADMIN_LINK_UNREAD;
  if (availability === 'reading') return "Reading this version's settings.";
  if (managerLinkPending(state, context) === 'failed') return ADMIN_LINK_MANAGER_UNREAD;
  const choice = chosenAdminLink(state, context);
  if (!choice.on) return 'Not linked. The uploader runs standalone.';
  const token = choice.tokenSource === 'stored' ? "the manager's stored token" : 'a token typed here';
  return `Linked to ${choice.url}, with ${token}.`;
}

/**
 * The settings list with the two keys pointed at the group, for a deployment
 * that runs an uploader on a version whose list lets the group set both, so
 * Advanced settings does not offer a second way to set them. Every other key,
 * and every key of any other deployment, is left as the list gives it.
 */
export function withAdminLinkPointed(entries: readonly DeploymentSettingEntry[], state: WizardState): DeploymentSettingEntry[] {
  if (!asksAdminLink(state) || !takesAdminLink(entries)) return [...entries];
  return entries.map((entry) =>
    (entry.key === ADMIN_API_URL_KEY || entry.key === ADMIN_API_TOKEN_KEY) && entry.owner === null && entry.declared
      ? { ...entry, owner: 'admin-link' }
      : entry,
  );
}
