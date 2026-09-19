/**
 * The three fields T27 added, from the request body to the service and back out
 * on a read.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The rules have tests of their own, against the schema and against the
 * service. What none of those can see is the handler in between: every field a
 * route carries is a line somebody wrote by hand in `routes/profiles.ts` or
 * `routes/groups.ts`, and a dropped line reads as an operator's choice being
 * ignored while every other test stays green.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createGroupsRouter } from '../../src/api/routes/groups.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';
import type { UploaderHealthService } from '../../src/domain/UploaderHealthService.js';
import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';

const ENDPOINT = 'https://rpc.example.org/v3/key';

const apps: RouterTestApp[] = [];
after(async () => {
  for (const app of apps) await app.close();
});

async function opened(app: Promise<RouterTestApp>): Promise<RouterTestApp> {
  const ready = await app;
  apps.push(ready);
  return ready;
}

/** What each route handler handed the service, and nothing else. */
class RecordingService {
  readonly created: Record<string, unknown>[] = [];

  readonly updated: Record<string, unknown>[] = [];

  readonly groups: Record<string, unknown>[] = [];

  asService(): ProfileService {
    return this as unknown as ProfileService;
  }

  async create(input: Record<string, unknown>): Promise<Profile> {
    this.created.push(input);
    return makeProfile({ name: String(input.name) });
  }

  async update(name: string, input: Record<string, unknown>): Promise<Profile> {
    this.updated.push({ name, ...input });
    return makeProfile({ name });
  }

  async createGroup(input: Record<string, unknown>): Promise<unknown> {
    this.groups.push(input);
    return { group: { id: 1, name: input.group_name }, profiles: [] };
  }
}

const noHealth = {} as unknown as UploaderHealthService;

describe('what the profile routes carry to the service', () => {
  it('takes the mode, the source and the address off a create body', async () => {
    const service = new RecordingService();
    const app = await opened(
      startRouterTestApp(createProfilesRouter(service.asService(), noHealth, true), '/profiles'),
    );

    const res = await call(app, 'POST', '/profiles', {
      name: 'stage',
      kind: 'custom',
      components: ['bee-uploader'],
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    });

    assert.equal(res.status, 202);
    assert.deepEqual(
      {
        node_mode: service.created[0]?.node_mode,
        rpc_endpoint_source: service.created[0]?.rpc_endpoint_source,
        rpc_endpoint: service.created[0]?.rpc_endpoint,
      },
      { node_mode: 'light', rpc_endpoint_source: 'custom', rpc_endpoint: ENDPOINT },
    );
  });

  it('takes the mode, the source and the address off an update body', async () => {
    const service = new RecordingService();
    const app = await opened(
      startRouterTestApp(createProfilesRouter(service.asService(), noHealth, true), '/profiles'),
    );

    const res = await call(app, 'PUT', '/profiles/stage', {
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    });

    assert.equal(res.status, 202);
    assert.deepEqual(
      {
        node_mode: service.updated[0]?.node_mode,
        rpc_endpoint_source: service.updated[0]?.rpc_endpoint_source,
        rpc_endpoint: service.updated[0]?.rpc_endpoint,
      },
      { node_mode: 'light', rpc_endpoint_source: 'custom', rpc_endpoint: ENDPOINT },
    );
  });

  it('takes all three off a group body', async () => {
    const service = new RecordingService();
    const app = await opened(
      startRouterTestApp(createGroupsRouter(service.asService(), true), '/groups'),
    );

    const res = await call(app, 'POST', '/groups', {
      group_name: 'pool',
      size: 2,
      kind: 'custom',
      components: ['bee-uploader'],
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    });

    assert.equal(res.status, 202);
    assert.deepEqual(
      {
        node_mode: service.groups[0]?.node_mode,
        rpc_endpoint_source: service.groups[0]?.rpc_endpoint_source,
        rpc_endpoint: service.groups[0]?.rpc_endpoint,
      },
      { node_mode: 'light', rpc_endpoint_source: 'custom', rpc_endpoint: ENDPOINT },
    );
  });
});

describe('what a read answers about a deployment’s node', () => {
  const stored = makeProfile({
    name: 'stage',
    node_mode: 'light',
    rpc_endpoint_source: 'custom',
    rpc_endpoint: ENDPOINT,
  });

  it('carries both fields on the list and on one deployment', async () => {
    const harness = profileServiceHarness([stored]);
    const app = await opened(
      startRouterTestApp(createProfilesRouter(harness.service, noHealth, true), '/profiles'),
    );

    const list = await call(app, 'GET', '/profiles');
    const one = await call(app, 'GET', '/profiles/stage');

    const listed = (list.body as { profiles: Profile[] }).profiles[0];
    assert.equal(listed?.node_mode, 'light');
    assert.equal(listed?.rpc_endpoint_source, 'custom');
    assert.equal(listed?.has_rpc_endpoint, true);
    assert.equal(listed?.rpc_endpoint_host, 'rpc.example.org');
    assert.equal('rpc_endpoint' in (listed ?? {}), false);
    const single = one.body as Profile;
    assert.equal(single.node_mode, 'light');
    assert.equal(single.rpc_endpoint_source, 'custom');
    assert.equal(single.has_rpc_endpoint, true);
    assert.equal(single.rpc_endpoint_host, 'rpc.example.org');
    assert.equal('rpc_endpoint' in single, false);
  });
});
