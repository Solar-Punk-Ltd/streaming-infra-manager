import type {
  AdminLinkTestAnswer,
  AdminLinkTestRequest,
  ManagerAdminLink,
  ManagerAdminLinkSave,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

/**
 * The web2 admin link, over the routes of `manager/src/api/routes/managerSettings.ts`
 * and `adminLinkTest.ts`: the manager's own link for new deployments, and
 * Test connection. No answer carries a token, and nothing here ever writes a
 * value to the console.
 */

const MANAGER_LINK_PATH = '/manager-settings/admin-link';

export function fetchManagerAdminLink(signal?: AbortSignal): Promise<ManagerAdminLink> {
  return getJson<ManagerAdminLink>(MANAGER_LINK_PATH, { cache: 'no-store', signal });
}

/** Stores the link at the revision the page read, and answers it as it stands after. */
export function saveManagerAdminLink(save: ManagerAdminLinkSave): Promise<ManagerAdminLink> {
  return sendJson<ManagerAdminLink>('PUT', MANAGER_LINK_PATH, save);
}

/** Tests an address typed on the page, with a typed token or the manager's stored one. */
export function testAdminLink(request: AdminLinkTestRequest): Promise<AdminLinkTestAnswer> {
  return sendJson<AdminLinkTestAnswer>('POST', `${MANAGER_LINK_PATH}/test`, request);
}

/** Tests what a deployment's next deploy would give its uploader. */
export function testDeploymentAdminLink(name: string): Promise<AdminLinkTestAnswer> {
  return sendJson<AdminLinkTestAnswer>('POST', `/profiles/${encodeURIComponent(name)}/settings/admin-link/test`, {});
}
