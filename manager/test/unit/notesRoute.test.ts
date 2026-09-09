/**
 * Saving a deployment's notes, over HTTP.
 *
 * Unit test: the profiles router on a random port, with the profile
 * repository in memory and the orchestrator standing in. `pnpm test` in
 * manager/.
 *
 * A note is text on the row that no container reads, so saving one takes no
 * claim on the deployment, asks no gate about stamps or funds, and starts no
 * deploy. And two pages that loaded the same note must not overwrite each
 * other without knowing, which is what the revision every save carries is
 * for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { ProfileStatus } from '../../src/types/index.js';
import {
  profileRow,
  profileServiceHarness,
  type ProfileServiceHarness,
} from '../support/profileServiceHarness.js';
import {
  call,
  startRouterTestApp,
  type RouterTestApp,
} from '../support/routerTestApp.js';

/** The revision the row is at when a page loads it. */
const LOADED_REVISION = 3;

interface Saved {
  notes: string | null;
  notes_revision: number;
  status: string;
}

async function withApp(
  status: ProfileStatus,
  run: (app: RouterTestApp, harness: ProfileServiceHarness) => Promise<void>,
): Promise<void> {
  const harness = profileServiceHarness([
    profileRow({ status, notes: 'the old note', notes_revision: LOADED_REVISION }),
  ]);
  const app = await startRouterTestApp(createProfilesRouter(harness.service), '/profiles');
  try {
    await run(app, harness);
  } finally {
    await app.close();
  }
}

const notesPatch = (notes: string | null, revision = LOADED_REVISION) => ({
  notes,
  notes_revision: revision,
});

describe('PATCH /profiles/:name/notes', () => {
  it('saves the note and nothing else: no claim, no deploy, no change of status', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PATCH', '/profiles/stream1/notes', notesPatch('a new note'));

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const saved = res.body as Saved;
      assert.equal(saved.notes, 'a new note');
      assert.equal(saved.notes_revision, LOADED_REVISION + 1);
      assert.equal(saved.status, 'RUNNING');
      assert.deepEqual(harness.orchestrator.reserved, [], 'no claim was taken');
      assert.deepEqual(harness.orchestrator.deploys, [], 'nothing was deployed');
      assert.equal(harness.profiles.rows.get('stream1')?.notes, 'a new note');
    }));

  it('clears the note with null', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PATCH', '/profiles/stream1/notes', notesPatch(null));

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(harness.profiles.rows.get('stream1')?.notes, null);
    }));

  it('saves while a deploy is running, since it touches nothing the deploy does', () =>
    withApp('DEPLOYING', async (app, harness) => {
      const res = await call(app, 'PATCH', '/profiles/stream1/notes', notesPatch('noted mid deploy'));

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(harness.profiles.rows.get('stream1')?.status, 'DEPLOYING');
    }));

  it('refuses a save from a page that loaded before another save, and changes nothing', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(
        app,
        'PATCH',
        '/profiles/stream1/notes',
        notesPatch('from a stale page', LOADED_REVISION - 1),
      );

      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal((res.body as { error?: string }).error, 'notes_conflict');
      assert.match((res.body as { message?: string }).message ?? '', /changed since this page loaded/);
      assert.equal(harness.profiles.rows.get('stream1')?.notes, 'the old note');
      assert.equal(harness.profiles.rows.get('stream1')?.notes_revision, LOADED_REVISION);
    }));

  it('lets exactly one of two saves from the same loaded revision through', () =>
    withApp('RUNNING', async (app, harness) => {
      const [first, second] = await Promise.all([
        call(app, 'PATCH', '/profiles/stream1/notes', notesPatch('from page one')),
        call(app, 'PATCH', '/profiles/stream1/notes', notesPatch('from page two')),
      ]);

      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      const kept = harness.profiles.rows.get('stream1')?.notes;
      assert.ok(kept === 'from page one' || kept === 'from page two', String(kept));
      assert.equal(harness.profiles.rows.get('stream1')?.notes_revision, LOADED_REVISION + 1);
    }));

  it('answers 404 for a deployment that does not exist', () =>
    withApp('RUNNING', async (app) => {
      const res = await call(app, 'PATCH', '/profiles/nobody/notes', notesPatch('x'));

      assert.equal(res.status, 404, JSON.stringify(res.body));
    }));

  it('refuses a note over 500 characters, and a body without the revision', () =>
    withApp('RUNNING', async (app, harness) => {
      const long = await call(app, 'PATCH', '/profiles/stream1/notes', notesPatch('x'.repeat(501)));
      const bare = await call(app, 'PATCH', '/profiles/stream1/notes', { notes: 'x' });

      assert.equal(long.status, 400, JSON.stringify(long.body));
      assert.equal(bare.status, 400, JSON.stringify(bare.body));
      assert.equal(harness.profiles.rows.get('stream1')?.notes, 'the old note');
    }));
});

describe('PUT /profiles/:name with notes', () => {
  it('takes the revision the drawer loaded, and moves it with the note', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PUT', '/profiles/stream1', {
        notes: 'edited in the drawer',
        notes_revision: LOADED_REVISION,
      });

      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal((res.body as Saved).notes_revision, LOADED_REVISION + 1);
      assert.deepEqual(
        harness.orchestrator.deploys.map((deploy) => deploy.profileName),
        ['stream1'],
      );
    }));

  it('refuses a stale drawer before any claim is taken, and deploys nothing', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PUT', '/profiles/stream1', {
        notes: 'from a stale drawer',
        notes_revision: LOADED_REVISION - 1,
      });

      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal((res.body as { error?: string }).error, 'notes_conflict');
      assert.deepEqual(harness.orchestrator.reserved, [], 'no claim was taken');
      assert.deepEqual(harness.orchestrator.deploys, []);
      assert.equal(harness.profiles.rows.get('stream1')?.status, 'RUNNING');
      assert.equal(harness.profiles.rows.get('stream1')?.notes, 'the old note');
    }));

  it('still takes a body without a revision, the way older clients send it', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PUT', '/profiles/stream1', { notes: 'from an older client' });

      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(harness.profiles.rows.get('stream1')?.notes, 'from an older client');
    }));

  it('leaves the revision alone when the note did not change', () =>
    withApp('RUNNING', async (app, harness) => {
      const res = await call(app, 'PUT', '/profiles/stream1', { notes: 'the old note' });

      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(harness.profiles.rows.get('stream1')?.notes_revision, LOADED_REVISION);
    }));
});
