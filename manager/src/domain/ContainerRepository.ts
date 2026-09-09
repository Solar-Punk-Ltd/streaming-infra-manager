import { Pool } from 'pg';

import { ApiContainer, Profile, ProfileWithContainers } from '../types/index.js';

import { ContainerSnapshot } from './containerKeysSpec.js';
import { isPendingStamp } from './stampLogic.js';

export interface ContainerRow {
  profile_name: string;
  service: string;
  ports: Record<string, number>;
  env: Record<string, string>;
  build_id: string | null;
  build_commit: string | null;
  created_at: Date;
  updated_at: Date;
}

export class ContainerRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(
    profileName: string,
    snapshot: ContainerSnapshot,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO containers (profile_name, service, ports, env)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)
       ON CONFLICT (profile_name, service) DO UPDATE
         SET ports = EXCLUDED.ports,
             env = EXCLUDED.env,
             updated_at = NOW()`,
      [
        profileName,
        snapshot.service,
        JSON.stringify(snapshot.ports),
        JSON.stringify(snapshot.env),
      ],
    );
  }

  /** What the service's container was seen to be started from. Only a row a deploy wrote is updated. */
  async setBuild(
    profileName: string,
    service: string,
    buildId: string,
    buildCommit: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE containers SET build_id = $3, build_commit = $4, updated_at = NOW()
        WHERE profile_name = $1 AND service = $2`,
      [profileName, service, buildId, buildCommit],
    );
  }

  async listForProfile(profileName: string): Promise<ContainerRow[]> {
    const r = await this.pool.query<ContainerRow>(
      `SELECT profile_name, service, ports, env, build_id, build_commit, created_at, updated_at
         FROM containers
        WHERE profile_name = $1
        ORDER BY service ASC`,
      [profileName],
    );
    return r.rows;
  }

  async listApiContainers(profileName: string): Promise<ApiContainer[]> {
    const rows = await this.listForProfile(profileName);
    return rows.map((row) => ({
      service: row.service,
      ports: row.ports,
      buildId: row.build_id,
      buildCommit: row.build_commit,
    }));
  }

  async withContainers(profile: Profile): Promise<ProfileWithContainers> {
    const containers = await this.listApiContainers(profile.name);
    return { ...profile, containers, pendingStamp: isPendingStamp(profile) };
  }
}
