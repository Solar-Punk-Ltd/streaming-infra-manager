import type { Pool, PoolClient } from 'pg';
import { ownsBeeNode } from '@streaming-infra-manager/common';
import { PROFILE_SLOT_LOCK_KEY } from '../profileSql.js';
import { targetAlias } from '../ports/DeployTargets.js';
import { ChequebookProfileChangedError } from '../errors/ChequebookProfileChangedError.js';
import { ChequebookTargetChangedError } from '../errors/ChequebookTargetChangedError.js';
import { sameFrozenTarget, targetLockIdentity, type FrozenChequebookTarget } from './FrozenChequebookTarget.js';

type ProfileRow = {
  name: string; instance_id: string; intent_revision: number; engine_config_revision: number;
  kind: string; components: string[] | null; host: string | null; port_slot: number; stack_version_id: number | null; status: string;
};
type ReservationRow = { id: number; protocol: string; port: number; service: string | null; port_var: string; state: string; held_services: (string | null)[] };

/** All network inspection is outside these short SQL transactions. */
export class PostgresChequebookTargetOwnership {
  constructor(private readonly pool: Pool) {}

  async capture(profileName: string, instanceId: string): Promise<FrozenChequebookTarget> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
      const locator = await client.query<{ host: string | null; daemon_id: string | null }>(`SELECT profile.host, target.daemon_id
        FROM profiles profile LEFT JOIN deploy_targets target ON target.alias=COALESCE(NULLIF(profile.host,''),'localhost')
        WHERE profile.name=$1`, [profileName]);
      const row = locator.rows[0];
      if (!row) throw new ChequebookProfileChangedError();
      const identity = targetLockIdentity({ alias: targetAlias(row.host), daemonId: row.daemon_id });
      const proof = await this.lockAndRead(client, profileName, instanceId, identity);
      await client.query('COMMIT');
      return proof;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async requireCurrent(client: PoolClient, profileName: string, instanceId: string | null, expected: unknown): Promise<FrozenChequebookTarget> {
    const identity = targetLockIdentity(expected);
    const current = await this.lockAndRead(client, profileName, instanceId, identity);
    if (!sameFrozenTarget(expected, current)) throw new ChequebookTargetChangedError();
    return current;
  }

  private async lockAndRead(client: PoolClient, profileName: string, instanceId: string | null,
    identity: Pick<FrozenChequebookTarget, 'alias' | 'daemonId'>): Promise<FrozenChequebookTarget> {
    await client.query('SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy-attempts:${identity.daemonId}`]);
    const profiles = await client.query<ProfileRow>(`SELECT name, instance_id, intent_revision, engine_config_revision,
      kind, components, host, port_slot, stack_version_id, status FROM profiles WHERE name=$1 FOR UPDATE`, [profileName]);
    const profile = profiles.rows[0];
    if (!profile || profile.instance_id !== instanceId) throw new ChequebookProfileChangedError();
    if (targetAlias(profile.host) !== identity.alias || !ownsBeeNode(profile) ||
        !['RUNNING', 'STOPPED', 'ERROR'].includes(profile.status) || !profile.stack_version_id) throw new ChequebookTargetChangedError();
    const targets = await client.query<{ daemon_id: string | null; verified_at: string | null; last_error: string | null }>(`SELECT daemon_id,
      to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS verified_at, last_error
      FROM deploy_targets WHERE alias=$1 FOR SHARE`, [identity.alias]);
    const target = targets.rows[0];
    if (!target || target.daemon_id !== identity.daemonId || !target.verified_at || target.last_error !== null) throw new ChequebookTargetChangedError();
    const seeded = await client.query('SELECT 1 FROM reservation_daemon_inventory WHERE daemon_id=$1 FOR SHARE', [identity.daemonId]);
    if (!seeded.rows[0]) throw new ChequebookTargetChangedError();
    const reservations = await client.query<ReservationRow>(`SELECT id, protocol, port, service, port_var, state, held_services
      FROM port_reservations WHERE daemon_id=$1 AND profile_name=$2 AND port_var='BEE_UPLOADER_API_PORT' ORDER BY id FOR UPDATE`, [identity.daemonId, profileName]);
    const reservation = reservations.rows[0];
    if (reservations.rows.length !== 1 || !reservation || reservation.protocol !== 'tcp' || reservation.service !== 'bee-uploader' ||
        reservation.state !== 'active' || reservation.held_services.length !== 1 || reservation.held_services[0] !== 'bee-uploader') throw new ChequebookTargetChangedError();
    const unresolved = await client.query("SELECT 1 FROM deploy_attempts WHERE daemon_id=$1 AND project=$2 AND state<>'released' LIMIT 1", [identity.daemonId, profileName]);
    if (unresolved.rows[0]) throw new ChequebookTargetChangedError();
    return {
      version: 1,
      profile: { name: profile.name, instanceId: profile.instance_id, intentRevision: profile.intent_revision, engineConfigRevision: profile.engine_config_revision,
        kind: profile.kind, components: profile.components, host: profile.host, portSlot: profile.port_slot, stackVersionId: profile.stack_version_id, status: profile.status },
      alias: identity.alias, daemonId: identity.daemonId, verifiedAt: target.verified_at,
      reservation: { id: reservation.id, protocol: 'tcp', port: reservation.port, service: 'bee-uploader', portVar: 'BEE_UPLOADER_API_PORT' },
    };
  }
}
