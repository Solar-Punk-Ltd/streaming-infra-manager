import { ADMIN_API_TOKEN_KEY } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';

import { ManagerAdminTokenMissingError } from '../errors/index.js';

/**
 * Copies the manager's stored web2 admin token into one new deployment's
 * secret settings, inside the transaction that inserted it, so the token goes
 * from one column to the other and never through the manager or a page.
 * Throws when none is stored, which rolls the whole insert back.
 */
export async function copyManagerAdminToken(client: PoolClient, profileName: string): Promise<void> {
  const copied = await client.query(
    `UPDATE profiles p
        SET stack_settings_secret = p.stack_settings_secret || jsonb_build_object($2::text, link.token)
       FROM manager_admin_link link
      WHERE p.name = $1 AND link.token IS NOT NULL`,
    [profileName, ADMIN_API_TOKEN_KEY],
  );
  if (copied.rowCount !== 1) throw new ManagerAdminTokenMissingError();
}
