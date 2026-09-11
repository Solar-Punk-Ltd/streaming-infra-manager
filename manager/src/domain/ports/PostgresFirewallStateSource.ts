import type { Pool } from 'pg';
import type { FirewallState, FirewallStateSource } from './firewallInventoryTypes.js';

/** One statement gives every table the same PostgreSQL snapshot and selects no credential columns. */
export class PostgresFirewallStateSource implements FirewallStateSource {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<FirewallState> {
    const result = await this.pool.query<{ state: FirewallState }>(`
      SELECT jsonb_build_object(
        'inventoryReady', COALESCE((SELECT seeded_at IS NOT NULL FROM reservation_inventory WHERE id = 1), false),
        'seededDaemons', COALESCE((SELECT jsonb_agg(daemon_id ORDER BY daemon_id) FROM reservation_daemon_inventory), '[]'),
        'targets', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY alias) FROM (
          SELECT alias, daemon_id AS "daemonId", verified_at IS NOT NULL AS verified FROM deploy_targets
        ) t), '[]'),
        'profiles', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM (
          SELECT name, port_slot AS slot, status, COALESCE(NULLIF(BTRIM(host), ''), 'localhost') AS target,
            stack_version_id AS "versionId", updated_at AS "updatedAt" FROM profiles
        ) p), '[]'),
        'versions', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM (
          SELECT id, name, layout, root_path AS "rootPath", build_id AS "buildId", previous_build_id AS "previousBuildId"
          FROM stack_versions
        ) v), '[]'),
        'references', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM (
          SELECT id, version_id AS "versionId", build_id AS "buildId", holder_kind AS "holderKind",
            holder_id AS "holderId", services FROM build_references WHERE resolved_at IS NULL
        ) r), '[]'),
        'reservations', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM (
          SELECT id, daemon_id AS "daemonId", profile_name AS "profileName", protocol, port,
            held_services AS "heldServices", state, updated_at AS "updatedAt" FROM port_reservations
        ) r), '[]'),
        'attempts', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM (
          SELECT id, project, daemon_id AS "daemonId", state FROM deploy_attempts WHERE state <> 'released'
        ) a), '[]')
      ) AS state
    `);
    if (!result.rows[0]) throw new Error('No firewall database snapshot was returned');
    return result.rows[0].state;
  }
}
