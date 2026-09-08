import type { GroupKind, StackPortVar } from '@streaming-infra-manager/common';
import { Pool, PoolClient } from 'pg';
import { DeploymentGroup, Profile } from '../types/interfaces.js';
import { ProfileKind } from '../types/types.js';
import { AllSlotsUsedError } from './errors/index.js';
import { reserveSlotFor } from './ports/reservationSql.js';
import { PROFILE_COLUMNS, PROFILE_SLOT_LOCK_KEY } from './profileSql.js';

export interface SharedProfileParams {
  kind: ProfileKind;
  notes: string | null;
  components: string[] | null;
  host: string | null;
  feed_owner: string | null;
  feed_topic: string | null;
  private_key: string | null;
  public_key: string | null;
  stamp_id: string | null;
  srt_passphrase: string | null;
  /** Every member of a group runs one version, the one the group was made on. */
  stack_version_id: number;
  /** The highest slot a member may get: the version's own maximum, never above the manager's. */
  slot_cap: number;
  /** The daemon the members' ports belong to, from `docker info`. */
  daemon_id: string;
  /** The version's port table, every port of which each member's slot reserves. */
  table: readonly StackPortVar[];
}

export interface MemberSeed {
  name: string;
}

export interface MemberConfigWrite {
  name: string;
  kind: ProfileKind;
  notes: string | null;
  components: string[] | null;
  feed_owner: string | null;
  feed_topic: string | null;
  private_key: string | null;
  public_key: string | null;
  stamp_id: string | null;
  srt_passphrase: string | null;
}

export class DeploymentGroupRepository {
  constructor(private readonly pool: Pool) {}

  async findByName(name: string): Promise<DeploymentGroup | null> {
    const r = await this.pool.query<DeploymentGroup>(
      'SELECT id, name, size, kind, created_at FROM deployment_groups WHERE name = $1',
      [name],
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
  }

  async findById(id: number): Promise<DeploymentGroup | null> {
    const r = await this.pool.query<DeploymentGroup>(
      'SELECT id, name, size, kind, created_at FROM deployment_groups WHERE id = $1',
      [id],
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
  }

  async list(): Promise<DeploymentGroup[]> {
    const r = await this.pool.query<DeploymentGroup>(
      'SELECT id, name, size, kind, created_at FROM deployment_groups ORDER BY created_at ASC',
    );
    return r.rows;
  }

  async syncMembershipAfterRemoval(
    groupId: number,
  ): Promise<'deleted' | 'resized'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const deleted = await client.query(
        `DELETE FROM deployment_groups g
          WHERE g.id = $1
            AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.group_id = $1)`,
        [groupId],
      );
      if ((deleted.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return 'deleted';
      }

      await client.query(
        `UPDATE deployment_groups
            SET size = (SELECT COUNT(*) FROM profiles WHERE group_id = $1)
          WHERE id = $1`,
        [groupId],
      );
      await client.query('COMMIT');
      return 'resized';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listMembers(groupId: number): Promise<Profile[]> {
    const r = await this.pool.query<Profile>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE group_id = $1 ORDER BY port_slot ASC`,
      [groupId],
    );
    return r.rows;
  }

  async updateMembersConfig(writes: MemberConfigWrite[]): Promise<Profile[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const profiles: Profile[] = [];
      for (const w of writes) {
        const r = await client.query<Profile>(
          `UPDATE profiles
             SET kind = $2,
                 notes = $3,
                 components = $4,
                 feed_owner = $5,
                 feed_topic = $6,
                 private_key = $7,
                 public_key = $8,
                 stamp_id = $9,
                 srt_passphrase = $10,
                 updated_at = NOW()
           WHERE name = $1
           RETURNING ${PROFILE_COLUMNS}`,
          [
            w.name,
            w.kind,
            w.notes,
            w.components,
            w.feed_owner,
            w.feed_topic,
            w.private_key,
            w.public_key,
            w.stamp_id,
            w.srt_passphrase,
          ],
        );

        if (!r.rowCount || r.rowCount === 0) {
          throw new Error(
            `profile not found during group config update: ${w.name}`,
          );
        }

        profiles.push(r.rows[0]!);
      }
      await client.query('COMMIT');
      return profiles;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertMemberWithFreeSlot(
    client: PoolClient,
    name: string,
    shared: SharedProfileParams,
    groupId: number,
  ): Promise<Profile> {
    const placement = { slotCap: shared.slot_cap, daemonId: shared.daemon_id, table: shared.table };
    const slot = await reserveSlotFor(client, name, placement);
    if (slot === null) {
      throw new AllSlotsUsedError(shared.slot_cap);
    }
    const r = await client.query<Profile>(
      `INSERT INTO profiles (
         name, port_slot, kind, notes, status,
         components, host, feed_owner, feed_topic, private_key, public_key, stamp_id,
         srt_passphrase, group_id, stack_version_id
       )
       VALUES ($1, $2, $3, $4, 'STOPPED', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${PROFILE_COLUMNS}`,
      [
        name,
        slot,
        shared.kind,
        shared.notes,
        shared.components,
        shared.host,
        shared.feed_owner,
        shared.feed_topic,
        shared.private_key,
        shared.public_key,
        shared.stamp_id,
        shared.srt_passphrase,
        groupId,
        shared.stack_version_id,
      ],
    );
    return r.rows[0]!;
  }

  async createGroupWithMembers(
    groupName: string,
    kind: GroupKind,
    members: MemberSeed[],
    shared: SharedProfileParams,
  ): Promise<{ group: DeploymentGroup; profiles: Profile[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        PROFILE_SLOT_LOCK_KEY,
      ]);

      const groupResult = await client.query<DeploymentGroup>(
        `INSERT INTO deployment_groups (name, size, kind)
         VALUES ($1, $2, $3)
         RETURNING id, name, size, kind, created_at`,
        [groupName, members.length, kind],
      );
      const group = groupResult.rows[0]!;

      const profiles: Profile[] = [];
      for (const m of members) {
        profiles.push(
          await this.insertMemberWithFreeSlot(client, m.name, shared, group.id),
        );
      }

      await client.query('COMMIT');
      return { group, profiles };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async addMembers(
    groupId: number,
    members: MemberSeed[],
    shared: SharedProfileParams,
  ): Promise<Profile[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        PROFILE_SLOT_LOCK_KEY,
      ]);

      const profiles: Profile[] = [];
      for (const m of members) {
        profiles.push(
          await this.insertMemberWithFreeSlot(client, m.name, shared, groupId),
        );
      }

      await client.query(
        `UPDATE deployment_groups
            SET size = (SELECT COUNT(*) FROM profiles WHERE group_id = $1)
          WHERE id = $1`,
        [groupId],
      );

      await client.query('COMMIT');
      return profiles;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
