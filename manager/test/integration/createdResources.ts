import { belongsToRun } from './target.js';

export interface CreatedProfileIdentity {
  readonly name: string;
  readonly instanceId: string;
}

export interface CreatedGroupIdentity {
  readonly id: number;
  readonly name: string;
}

export type CreationAttempt =
  | { readonly kind: 'profile' }
  | { readonly kind: 'group'; readonly expectedMembers: number }
  | { readonly kind: 'members'; readonly expectedMembers: number; readonly groupId: number };

export type UnresolvedCreationReason =
  | 'response-unavailable' | 'invalid-profile' | 'invalid-group' | 'missing-members'
  | 'invalid-member' | 'member-count-mismatch' | 'identity-conflict';

export interface UnresolvedCreation {
  readonly kind: CreationAttempt['kind'];
  readonly reason: UnresolvedCreationReason;
}

export interface CreatedResourceSnapshot {
  readonly profiles: readonly CreatedProfileIdentity[];
  readonly groups: readonly CreatedGroupIdentity[];
  readonly unresolved: readonly UnresolvedCreation[];
}

export interface CreateResponse {
  readonly status: number;
  readonly body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Response evidence grants cleanup authority. Requested names and later GETs do not. */
export class CreatedResourceInventory {
  private readonly profiles = new Map<string, CreatedProfileIdentity>();
  private readonly groups = new Map<number, CreatedGroupIdentity>();
  private readonly unresolved: UnresolvedCreation[] = [];

  constructor(private readonly runId: string) {
    if (!/^[a-z0-9]{1,8}$/.test(runId)) throw new Error('Invalid integration run id');
  }

  /** Record confirmed identities before the caller receives the response for assertions. */
  async capture<T extends CreateResponse>(attempt: CreationAttempt, request: () => Promise<T>): Promise<T> {
    if (attempt.kind !== 'profile' && !positiveInteger(attempt.expectedMembers)) {
      throw new Error('Expected member count must be a positive integer');
    }
    if (attempt.kind === 'members' && !positiveInteger(attempt.groupId)) {
      throw new Error('Expected group id must be a positive integer');
    }
    let response: T;
    try {
      response = await request();
    } catch {
      this.note(attempt, 'response-unavailable');
      throw new Error('Create response unavailable. Outcome is unresolved and grants no cleanup authority.');
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return response;
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      this.note(attempt, 'response-unavailable');
      return response;
    }
    if (attempt.kind === 'profile') {
      this.captureProfile(response.body, attempt, 'invalid-profile');
      return response;
    }
    const body = record(response.body);
    const group = this.parseGroup(body?.group);
    if (!group || (attempt.kind === 'members' && group.id !== attempt.groupId)) {
      this.note(attempt, 'invalid-group');
    } else if (attempt.kind === 'group') {
      const existing = this.groups.get(group.id);
      if (existing && existing.name !== group.name) this.note(attempt, 'identity-conflict');
      else this.groups.set(group.id, Object.freeze(group));
    }
    if (!Array.isArray(body?.profiles)) {
      this.note(attempt, 'missing-members');
      return response;
    }
    if (body.profiles.length !== attempt.expectedMembers) this.note(attempt, 'member-count-mismatch');
    for (const member of body.profiles) this.captureProfile(member, attempt, 'invalid-member');
    return response;
  }

  snapshot(): CreatedResourceSnapshot {
    return Object.freeze({
      profiles: Object.freeze([...this.profiles.values()]),
      groups: Object.freeze([...this.groups.values()]),
      unresolved: Object.freeze([...this.unresolved]),
    });
  }

  private captureProfile(value: unknown, attempt: CreationAttempt, invalid: UnresolvedCreationReason): void {
    const profile = record(value);
    if (!profile || !this.ownName(profile.name) || typeof profile.instance_id !== 'string' || !UUID.test(profile.instance_id)) {
      this.note(attempt, invalid);
      return;
    }
    const instanceId = profile.instance_id.toLowerCase();
    const existing = this.profiles.get(instanceId);
    if (existing && existing.name !== profile.name) {
      this.note(attempt, 'identity-conflict');
      return;
    }
    this.profiles.set(instanceId, Object.freeze({ name: profile.name, instanceId }));
  }

  private parseGroup(value: unknown): CreatedGroupIdentity | null {
    const group = record(value);
    return group && positiveInteger(group.id) && this.ownName(group.name)
      ? { id: group.id, name: group.name } : null;
  }

  private ownName(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value) && belongsToRun(this.runId, value);
  }

  private note(attempt: CreationAttempt, reason: UnresolvedCreationReason): void {
    this.unresolved.push(Object.freeze({ kind: attempt.kind, reason }));
  }
}
