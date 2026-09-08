import { cleanupCreatedResources, type CleanupOptions } from './cleanupCreatedResources.js';
import { cleanupHttpAdapter, type CleanupRequest } from './cleanupHttpAdapter.js';
import { CreatedResourceInventory, type CreationAttempt, type CreateResponse } from './createdResources.js';

function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function creationAttempt(method: string, path: string, value: unknown): CreationAttempt | null {
  if (method !== 'POST') return null;
  const body = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (path === '/profiles') return { kind: 'profile' };
  if (path === '/groups') return { kind: 'group', expectedMembers: body.abr_ladder === true ? 4 : positiveCount(body.size) };
  const match = /^\/groups\/([1-9]\d*)\/members$/.exec(path);
  const groupId = Number(match?.[1]);
  return match && Number.isSafeInteger(groupId) ? { kind: 'members', groupId, expectedMembers: positiveCount(body.count) } : null;
}

export class IntegrationResources {
  private readonly inventory: CreatedResourceInventory;
  private readonly adapter: ReturnType<typeof cleanupHttpAdapter>;

  constructor(runId: string, request: CleanupRequest, private readonly options: CleanupOptions = {}) {
    this.inventory = new CreatedResourceInventory(runId);
    this.adapter = cleanupHttpAdapter(request);
  }

  capture<T extends CreateResponse>(method: string, path: string, body: unknown, request: () => Promise<T>): Promise<T> {
    const attempt = creationAttempt(method, path, body);
    return attempt ? this.inventory.capture(attempt, request) : request();
  }

  async remove(name: string): Promise<void> {
    const profile = [...this.inventory.snapshot().profiles].reverse().find(profile => profile.name === name);
    if (!profile) throw new Error(`No confirmed creation identity is available for ${name}`);
    await cleanupCreatedResources({ profiles: [profile], groups: [], unresolved: [] }, this.adapter, this.options);
  }

  cleanup(): Promise<void> {
    return cleanupCreatedResources(this.inventory.snapshot(), this.adapter, this.options);
  }
}
