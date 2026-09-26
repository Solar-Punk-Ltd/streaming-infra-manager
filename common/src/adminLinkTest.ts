import { adminTokenProblem, adminUrlProblem } from './managerAdminLink.js';

/**
 * Test connection: the manager asks a web2 admin what the stream uploader
 * would ask it, from where the manager runs, and answers one of these codes.
 * The page gives one plain sentence for each. No answer carries anything the
 * admin said, the address or a token.
 */
export const ADMIN_LINK_TEST_OUTCOMES = [
  /** The admin took the token and signs its catalog with the deployment's stream address. */
  'linked',
  /** The admin took the token. There was no stream address to compare its owner with. */
  'token-accepted',
  /** The admin took the token but did not say which address it signs with, so the stream address was not compared. */
  'owner-unconfirmed',
  /** The admin took the token but signs with another address, which the uploader refuses to start with. */
  'owner-mismatch',
  /** The admin answered and refused the token. */
  'token-refused',
  /** Something answered at the address, but not as a web2 admin answers. */
  'not-admin',
  /** The address answered with a redirect, which the test does not follow. */
  'redirected',
  /** Nothing answered from where the manager runs, in time or at all. */
  'unreachable',
  /** The address is not an http or https one the uploader could use. */
  'invalid-address',
  /** There is no address, so the uploader runs standalone. */
  'not-linked',
  /** There is an address and no token, which the uploader refuses to start with. */
  'no-token',
] as const;

export type AdminLinkTestOutcome = (typeof ADMIN_LINK_TEST_OUTCOMES)[number];

/** The token a test presents: one typed on the page, or the manager's stored one, which never reaches the page. */
export type AdminLinkTokenChoice = { source: 'stored' } | { source: 'typed'; value: string };

/** What `POST /manager-settings/admin-link/test` takes. */
export interface AdminLinkTestRequest {
  url: string;
  token: AdminLinkTokenChoice;
  /** The address the deployment's stream key derives, compared with the admin's feed owner, where there is one. */
  feedOwner?: string | null;
}

/** What both Test connection routes answer. */
export interface AdminLinkTestAnswer {
  outcome: AdminLinkTestOutcome;
}

/** Why this request cannot be tested, one sentence each, or none. No sentence repeats the address or the token. */
export function adminLinkTestProblems({ url, token }: AdminLinkTestRequest): string[] {
  const problems: string[] = [];
  const urlProblem = url === '' ? 'Type the address of the web2 admin to test.' : adminUrlProblem(url);
  if (urlProblem) problems.push(urlProblem);
  if (token.source === 'typed') {
    const tokenProblem = token.value === '' ? 'Type a token to test with, or test with the stored one.' : adminTokenProblem(token.value);
    if (tokenProblem) problems.push(tokenProblem);
  }
  return problems;
}
