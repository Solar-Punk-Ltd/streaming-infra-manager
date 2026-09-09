import { number } from 'yup';
import { cleanupCreatedResources, type CleanupOptions } from './cleanupCreatedResources.js';
import { cleanupHttpAdapter, type CleanupRequest } from './cleanupHttpAdapter.js';
import { CreatedResourceInventory, type CreationAttempt, type CreateResponse } from './createdResources.js';

const memberCountSchema = number().required().integer().min(1);

function positiveCount(value: unknown): number | null {
  try {
    const count = memberCountSchema.validateSync(value);
    return Number.isSafeInteger(count) ? count : null;
  } catch { return null; }
}

function creationAttempt(method: string, path: string, value: unknown): CreationAttempt | null {
  if (method.toUpperCase() !== 'POST') return null;
  const pathname = new URL(path, 'http://integration.invalid').pathname.replace(/\/+$/, '').toLowerCase();
  const body = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (pathname === '/profiles') return { kind: 'profile' };
  if (pathname === '/groups') return { kind: 'group', expectedMembers: body === null ? null : /^(true|1)$/i.test(String(body.abr_ladder)) ? 4 : positiveCount(body.size) };
  const match = /^\/groups\/([^/]+)\/members$/.exec(pathname);
  if (!match) return null;
  let decodedId: string;
  try { decodedId = decodeURIComponent(match[1]!); }
  catch { return null; }
  if (!/^[1-9]\d*$/.test(decodedId)) return null;
  const groupId = Number(decodedId);
  return Number.isSafeInteger(groupId) && groupId > 0 && groupId <= 2147483647
    ? { kind: 'members', groupId, expectedMembers: body === null ? null : positiveCount(body.count) } : null;
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
