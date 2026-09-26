import { ADMIN_API_TOKEN_KEY, sameAdminOrigin } from '@streaming-infra-manager/common';
import type { PoolClient } from 'pg';

import { ManagerAdminTokenElsewhereError, ManagerAdminTokenMissingError } from '../errors/index.js';
import type { ManagerAdminTokenCopy } from '../ProfileRepository.js';

/**
 * Copies the manager's stored web2 admin token into one new deployment's
 * secret settings, inside the transaction that inserted it, so the token goes
 * from one column to the other and never through the manager or a page.
 * Throws when none is stored, or when the deployment's address has another
 * origin than the one the token was saved with, which rolls the whole insert
 * back. The link's row stays locked until the insert ends, so a save of the
 * link cannot swap the token for one saved for another address in between.
 */
export async function copyManagerAdminToken(client: PoolClient, profileName: string, copy: ManagerAdminTokenCopy): Promise<void> {
  const link = await client.query<{ url: string | null }>('SELECT url FROM manager_admin_link WHERE token IS NOT NULL FOR SHARE');
  const stored = link.rows[0];
  if (!stored) throw new ManagerAdminTokenMissingError();
  if (!sameAdminOrigin(copy.url, stored.url ?? '')) throw new ManagerAdminTokenElsewhereError();
  const copied = await client.query(
    `UPDATE profiles p
        SET stack_settings_secret = p.stack_settings_secret || jsonb_build_object($2::text, link.token)
       FROM manager_admin_link link
      WHERE p.name = $1 AND link.token IS NOT NULL`,
    [profileName, ADMIN_API_TOKEN_KEY],
  );
  if (copied.rowCount !== 1) throw new ManagerAdminTokenMissingError();
}
