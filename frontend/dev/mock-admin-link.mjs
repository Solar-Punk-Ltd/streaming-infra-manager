/**
 * The manager's own web2 admin link, and Test connection, for the mock
 * manager: `GET` and `PUT /manager-settings/admin-link` and
 * `POST /manager-settings/admin-link/test`, in the shapes and with the refusals
 * of `manager/src/api/routes/managerSettings.ts` and `adminLinkTest.ts`. The
 * bodies are checked by the manager's own schemas and the shared rules.
 *
 * A token's value is never kept here, only that one is stored, which is all
 * the page is ever answered.
 *
 * Test connection asks nothing of anybody. Its outcome is read off the first
 * label of the address, so every sentence the page has for one can be seen
 * offline: `https://unreachable.admin.offline.example` answers `unreachable`,
 * `https://owner-mismatch.admin.offline.example` answers `owner-mismatch`, and
 * so on for each outcome. Any other address takes the token, and is linked
 * when there is a stream address to compare with the admin's owner.
 */
import {
  ADMIN_LINK_TEST_OUTCOMES,
  adminLinkTestProblems,
  managerAdminLinkProblems,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

import { saveManagerAdminLinkSchema, testAdminLinkSchema } from '../../manager/src/schemas/managerSettings.ts';
import { send } from './mock-http.mjs';

/** The manager's link, as its single-row table holds it, the token as whether one is stored. */
export const managerAdminLink = { url: null, tokenStored: false, revision: 0 };

function answer() {
  return { url: managerAdminLink.url, tokenStored: managerAdminLink.tokenStored, revision: managerAdminLink.revision };
}

/**
 * What Test connection answers for this address, as the manager would once
 * it had asked the admin. There is no test without an address, a usable one,
 * or a token.
 */
export function mockTestOutcome({ url, hasToken, feedOwner }) {
  if (!url) return 'not-linked';
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'invalid-address';
  }
  if (!hasToken) return 'no-token';
  const label = host.split('.')[0];
  if (ADMIN_LINK_TEST_OUTCOMES.includes(label)) return label;
  return feedOwner ? 'linked' : 'token-accepted';
}

/** A body the schema refuses, answered as the manager answers one: the reasons, which name no value. */
async function validBody(schema, req, readBody, res) {
  try {
    return await schema.validate(await readBody(req), { abortEarly: false, stripUnknown: false });
  } catch (error) {
    send(res, 400, { error: 'validation_error', errors: error.errors ?? ['The request body is not valid.'] });
    return null;
  }
}

async function save(req, res, readBody) {
  const body = await validBody(saveManagerAdminLinkSchema, req, readBody, res);
  if (!body) return;
  if (body.expectedRevision !== managerAdminLink.revision) {
    return send(res, 409, {
      error: 'manager_settings_changed',
      message: "The manager's settings changed after the page read them. Reload them and make the change again.",
    });
  }
  const problems = managerAdminLinkProblems(body, managerAdminLink);
  if (problems.length > 0) return send(res, 400, { error: 'validation_error', errors: problems });
  managerAdminLink.url = body.url === '' ? null : body.url;
  if (managerAdminLink.url === null) managerAdminLink.tokenStored = false;
  else if (body.token !== undefined) managerAdminLink.tokenStored = body.token !== null;
  managerAdminLink.revision += 1;
  return send(res, 200, answer(), { 'cache-control': 'no-store' });
}

async function test(req, res, readBody) {
  const body = await validBody(testAdminLinkSchema, req, readBody, res);
  if (!body) return;
  const problems = adminLinkTestProblems(body);
  if (problems.length > 0) return send(res, 400, { error: 'validation_error', errors: problems });
  if (body.token.source === 'stored' && managerAdminLink.tokenStored && !sameAdminOrigin(body.url, managerAdminLink.url ?? '')) {
    return send(res, 200, { outcome: 'stored-token-elsewhere' }, { 'cache-control': 'no-store' });
  }
  const hasToken = body.token.source === 'typed' || managerAdminLink.tokenStored;
  return send(res, 200, { outcome: mockTestOutcome({ url: body.url, hasToken, feedOwner: body.feedOwner ?? null }) }, { 'cache-control': 'no-store' });
}

/** @param deps.readBody reads a JSON request body */
export function adminLinkRoutes({ readBody }) {
  return [
    ['GET', /^\/manager-settings\/admin-link$/, (_req, res) => send(res, 200, answer(), { 'cache-control': 'no-store' })],
    ['PUT', /^\/manager-settings\/admin-link$/, (req, res) => save(req, res, readBody)],
    ['POST', /^\/manager-settings\/admin-link\/test$/, (req, res) => test(req, res, readBody)],
  ];
}
