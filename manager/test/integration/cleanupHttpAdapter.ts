import type { CleanupAdapter } from './cleanupCreatedResources.js';
import type { CreatedProfileIdentity } from './createdResources.js';

export type CleanupRequest = (method: string, path: string, body: unknown, signal: AbortSignal) => Promise<{ status: number; body?: unknown }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function profileIdentity(value: unknown, expected: CreatedProfileIdentity): 'present' | 'replaced' {
  const profile = record(value);
  if (profile?.name !== expected.name || typeof profile.instance_id !== 'string' || !UUID.test(profile.instance_id)) {
    throw new Error('Cleanup received an invalid deployment identity');
  }
  return profile.instance_id.toLowerCase() === expected.instanceId.toLowerCase() ? 'present' : 'replaced';
}
function invalidResponse(): never { throw new Error('Cleanup received an unexpected response'); }

/** Every mutation carries the confirmed identity. Only named domain responses prove absence or refusal. */
export function cleanupHttpAdapter(request: CleanupRequest): CleanupAdapter {
  return {
    async remove(profile, signal) {
      const result = await request('DELETE', `/profiles/${encodeURIComponent(profile.name)}`, { expectedInstanceId: profile.instanceId }, signal);
      const body = record(result.body);
      if (result.status === 404 && body?.error === 'profile_not_found' && body.name === profile.name) return 'absent';
      if (result.status === 409 && body?.error === 'profile_instance_changed' && body.name === profile.name) return 'replaced';
      if (result.status === 202 && profileIdentity(result.body, profile) === 'present' && body?.status === 'REMOVING') return 'accepted';
      return invalidResponse();
    },
    async read(profile, signal) {
      const result = await request('GET', `/profiles/${encodeURIComponent(profile.name)}`, undefined, signal);
      const body = record(result.body);
      if (result.status === 404 && body?.error === 'profile_not_found' && body.name === profile.name) return 'absent';
      if (result.status === 200) return profileIdentity(result.body, profile);
      return invalidResponse();
    },
    async removeEmptyGroup(group, signal) {
      const result = await request('DELETE', `/groups/${group.id}`, { expectedName: group.name }, signal);
      const body = record(result.body);
      if (result.status === 204) return 'accepted';
      if (result.status === 409 && body?.id === group.id) {
        if (body.error === 'group_changed') return 'changed';
        if (body.error === 'group_not_empty') return 'not-empty';
      }
      return invalidResponse();
    },
    async groupExists(group, signal) {
      const result = await request('GET', '/groups', undefined, signal);
      const body = record(result.body);
      if (result.status !== 200 || !Array.isArray(body?.groups)) return invalidResponse();
      const ids = new Set<number>();
      let exists = false;
      for (const value of body.groups) {
        const row = record(value);
        if (!row || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.name !== 'string' || !row.name || ids.has(row.id)) return invalidResponse();
        ids.add(row.id);
        if (row.id === group.id) {
          if (row.name !== group.name) return invalidResponse();
          exists = true;
        }
      }
      return exists;
    },
  };
}
