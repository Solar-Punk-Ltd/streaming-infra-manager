/**
 * The sign-in routes, driven over HTTP the way the browser drives them.
 *
 * The app is the real Express wiring on a random port, with the users and
 * sessions in memory instead of Postgres. Every case here is a claim the brief
 * makes about what the manager answers, and each one is a claim that is cheap
 * to break by accident: the empty-users state, the cookie's attributes, the
 * refusal of a write that arrives without the header a cross-origin page cannot
 * set, and the lockout schedule as an operator meets it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SESSION_IDLE_TIMEOUT_MS } from '@streaming-infra-manager/common';

import { LoginLimiter } from '../../src/domain/auth/LoginLimiter.js';
import { hashSessionToken } from '../../src/domain/auth/sessionToken.js';
import {
  AuthTestApp,
  call,
  openEventStream,
  sessionCookieFrom,
  signIn,
  startAuthTestApp,
} from '../support/authTestApp.js';

const USERNAME = 'levi';
const PASSWORD = 'a-long-enough-password';
const OTHER_PASSWORD = 'another-fine-password';

interface UserRow {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  sessions: number;
}

describe('with no users yet', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
  });
  after(() => app.close());

  it('still answers the health check, which Docker reads', async () => {
    const res = await call(app, 'GET', '/health');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('tells the sign-in page there is nobody to sign in as', async () => {
    const res = await call(app, 'GET', '/auth/session');

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'no_users' });
  });

  it('refuses a sign-in with the same reason', async () => {
    const res = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'no_users' });
  });

  it('keeps every other route shut', async () => {
    const res = await call(app, 'GET', '/profiles');

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'not_signed_in' });
  });
});

describe('signing in and out', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
  });
  after(() => app.close());

  it('sets a cookie the page script cannot read and a stranger cannot use', async () => {
    const res = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 204);
    const header = res.setCookie[0] ?? '';
    assert.match(header, /^sim_session=/);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
    assert.match(header, /Path=\//i);
  });

  it('marks the cookie Secure only when the browser was on HTTPS', async () => {
    const throughTheTunnel = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
    });
    const behindTheEdge = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: PASSWORD },
      headers: { 'x-forwarded-proto': 'https' },
    });

    // A Secure cookie set over plain http is dropped by the browser, and the
    // tunnel is plain http, so getting this wrong is a sign-in that loops.
    assert.doesNotMatch(throughTheTunnel.setCookie[0] ?? '', /;\s*Secure\b/i);
    assert.match(behindTheEdge.setCookie[0] ?? '', /;\s*Secure\b/i);
  });

  it('opens the rest of the API, which was shut a moment earlier', async () => {
    assert.equal((await call(app, 'GET', '/profiles')).status, 401);

    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    const res = await call(app, 'GET', '/profiles', { cookie });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { user: USERNAME });
  });

  it('says the same thing to a wrong password and an unknown name', async () => {
    const wrongPassword = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: 'not-the-password' },
    });
    const unknownUser = await call(app, 'POST', '/auth/login', {
      body: { username: 'nobody', password: PASSWORD },
    });

    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, { error: 'invalid_credentials' });
    assert.deepEqual(unknownUser.body, wrongPassword.body);
    assert.equal(sessionCookieFrom(wrongPassword.setCookie), null);
  });

  it('refuses a password too long to be one, before anything hashes it', async () => {
    const res = await call(app, 'POST', '/auth/login', {
      body: { username: USERNAME, password: 'x'.repeat(100_000) },
    });

    assert.equal(res.status, 400);
    assert.equal((res.body as { error: string }).error, 'validation_error');
  });

  it('signs out, and the cookie stops working', async () => {
    const { cookie } = await signIn(app, USERNAME, PASSWORD);
    assert.equal((await call(app, 'GET', '/profiles', { cookie })).status, 200);

    const out = await call(app, 'POST', '/auth/logout', { cookie });

    assert.equal(out.status, 204);
    assert.equal(sessionCookieFrom(out.setCookie), null);
    assert.equal((await call(app, 'GET', '/profiles', { cookie })).status, 401);
  });
});

// Its own app, because the limiter counts the client IP as well as the
// username, and every other test in this file signs in from the same address.
describe('too many attempts', () => {
  let app: AuthTestApp;
  const clock = { now: 1_700_000_000_000 };

  const OURS = '198.51.100.7';
  const ELSEWHERE = '203.0.113.9';
  const LATER = '203.0.113.10';

  const from = (ip: string) => ({ 'x-forwarded-for': ip });

  const login = (ip: string, username: string, password: string) =>
    call(app, 'POST', '/auth/login', {
      body: { username, password },
      headers: from(ip),
    });

  before(async () => {
    app = await startAuthTestApp(new LoginLimiter(() => clock.now));
    await app.authService.addUser(USERNAME, PASSWORD);
    await app.authService.addUser('mate', OTHER_PASSWORD);
  });
  after(() => app.close());

  it('locks after the fifth wrong password, and says for how long', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const res = await login(OURS, USERNAME, 'not-the-password');
      assert.equal(res.status, 401, `attempt ${i}`);
    }

    const locked = await login(OURS, USERNAME, 'not-the-password');

    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, {
      error: 'locked_out',
      retryAfterSeconds: 60,
    });
  });

  it('refuses the right password while it is locked', async () => {
    const res = await login(OURS, USERNAME, PASSWORD);

    assert.equal(res.status, 429);
    assert.equal(sessionCookieFrom(res.setCookie), null);
  });

  it('locks the address as well, so a second account cannot be tried from it', async () => {
    const res = await login(OURS, 'mate', OTHER_PASSWORD);

    assert.equal(res.status, 429);
  });

  it('leaves other addresses able to sign in', async () => {
    const res = await login(ELSEWHERE, 'mate', OTHER_PASSWORD);

    assert.equal(res.status, 204);
    assert.ok(sessionCookieFrom(res.setCookie));
  });

  it('lets the right password through once the wait is over, and forgets the count', async () => {
    clock.now += 60_000;

    assert.equal((await login(LATER, USERNAME, PASSWORD)).status, 204);

    // The successful sign-in cleared the username key, so four more misses
    // from a fresh address must not lock it again.
    for (let i = 1; i <= 4; i += 1) {
      const res = await login(LATER, USERNAME, 'not-the-password');
      assert.equal(res.status, 401, `attempt ${i} after the reset`);
    }
  });
});

// Its own app, so the count starts at zero: what matters here is how many of
// the requests got as far as hashing a password, and every other test in this
// file signs in too.
describe('a burst of sign-ins sent at once', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
  });
  after(() => app.close());

  it('lets only the free attempts pay for a password check', async () => {
    const sent = 20;
    const before = app.users.usernameLookups();

    const answers = await Promise.all(
      Array.from({ length: sent }, () =>
        call(app, 'POST', '/auth/login', {
          body: { username: USERNAME, password: 'not-the-password' },
        }),
      ),
    );

    const checked = app.users.usernameLookups() - before;
    assert.ok(
      checked <= 5,
      `${checked} of ${sent} guesses reached the password check`,
    );
    assert.equal(answers.filter((res) => res.status === 401).length, checked);
    assert.equal(answers.filter((res) => res.status === 429).length, sent - checked);
  });
});

// Its own app and its own clock, so the wait it reports is exact.
describe('too many wrong current passwords', () => {
  let app: AuthTestApp;
  let cookie: string;
  const clock = { now: 1_700_000_000_000 };

  before(async () => {
    app = await startAuthTestApp(new LoginLimiter(() => clock.now));
    await app.authService.addUser(USERNAME, PASSWORD);
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  it('locks the password change the way a sign-in is locked', async () => {
    const wrongCurrent = () =>
      call(app, 'POST', '/auth/password', {
        cookie,
        body: { current: 'not-the-password', next: 'a-fine-new-password' },
      });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal((await wrongCurrent()).status, 401, `attempt ${attempt}`);
    }

    const locked = await wrongCurrent();

    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, '60');
    assert.deepEqual(locked.body, {
      error: 'locked_out',
      retryAfterSeconds: 60,
    });
  });

  it('lets the right current password through once the wait is over', async () => {
    clock.now += 60_000;

    const changed = await call(app, 'POST', '/auth/password', {
      cookie,
      body: { current: PASSWORD, next: OTHER_PASSWORD },
    });

    assert.equal(changed.status, 204);
  });
});

describe('cross-site writes', () => {
  let app: AuthTestApp;
  let cookie: string;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  it('refuses a write without the header, cookie or no cookie', async () => {
    for (const withCookie of [cookie, null]) {
      const res = await call(app, 'POST', '/profiles', {
        cookie: withCookie,
        requestedWith: false,
        body: {},
      });

      assert.equal(res.status, 403);
      assert.equal((res.body as { error: string }).error, 'cross_site_request');
    }
  });

  it('refuses a sign-in without the header as well', async () => {
    const res = await call(app, 'POST', '/auth/login', {
      requestedWith: false,
      body: { username: USERNAME, password: PASSWORD },
    });

    assert.equal(res.status, 403);
  });

  it('refuses a write the browser reports as cross-site', async () => {
    const res = await call(app, 'POST', '/profiles', {
      cookie,
      body: {},
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    assert.equal(res.status, 403);
  });

  it('allows the write our own page makes', async () => {
    const res = await call(app, 'POST', '/profiles', { cookie, body: {} });

    assert.equal(res.status, 201);
  });

  it('never sets a CORS header, so no other origin can read an answer', async () => {
    const res = await fetch(`${app.url}/health`);

    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });
});

// Its own app, because the whole case is two users and what they can do to
// each other at the same moment.
describe('two users removing each other at once', () => {
  it('refuses the removal that would empty the table', async () => {
    const app = await startAuthTestApp();
    const ann = await app.authService.addUser('ann', PASSWORD);
    const bob = await app.authService.addUser('bob', OTHER_PASSWORD);

    const outcomes = await Promise.allSettled([
      app.authService.removeUser(bob.id, ann.id),
      app.authService.removeUser(ann.id, bob.id),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
      'exactly one of the two removals may go through',
    );
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.match(
      String((refused as PromiseRejectedResult).reason),
      /last user/,
    );
    assert.equal(await app.users.count(), 1);

    await app.close();
  });
});

describe('managing users', () => {
  let app: AuthTestApp;
  let cookie: string;
  let ownId: number;

  before(async () => {
    app = await startAuthTestApp();
    ownId = (await app.authService.addUser(USERNAME, PASSWORD)).id;
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  const listUsers = async (): Promise<UserRow[]> => {
    const res = await call(app, 'GET', '/auth/users', { cookie });
    assert.equal(res.status, 200);
    return res.body as UserRow[];
  };

  it('lists who exists, when they last signed in, and how many sessions they hold', async () => {
    const users = await listUsers();

    assert.equal(users.length, 1);
    assert.equal(users[0]?.username, USERNAME);
    assert.equal(users[0]?.sessions, 1);
    assert.ok(users[0]?.lastLoginAt, 'the sign-in above should be recorded');
  });

  it('adds a user, and refuses the name a second time', async () => {
    const added = await call(app, 'POST', '/auth/users', {
      cookie,
      body: { username: 'mate', password: OTHER_PASSWORD },
    });
    assert.equal(added.status, 201);

    const again = await call(app, 'POST', '/auth/users', {
      cookie,
      body: { username: 'mate', password: OTHER_PASSWORD },
    });
    assert.equal(again.status, 409);
    assert.equal((again.body as { error: string }).error, 'user_exists');
  });

  it('refuses a password that is too short or carries the username', async () => {
    for (const [username, password] of [
      ['short', 'tiny'],
      ['carrier', 'the-carrier-one'],
    ]) {
      const res = await call(app, 'POST', '/auth/users', {
        cookie,
        body: { username, password },
      });

      assert.equal(res.status, 400, `${username} should be refused`);
      assert.equal(
        (res.body as { error: string }).error,
        'validation_error',
      );
    }
  });

  it('refuses a username the database would refuse', async () => {
    for (const username of ['A', 'has space', 'Upper', 'x'.repeat(33), '-lead']) {
      const res = await call(app, 'POST', '/auth/users', {
        cookie,
        body: { username, password: OTHER_PASSWORD },
      });

      assert.equal(res.status, 400, `${username} should be refused`);
    }
  });

  it('refuses to remove yourself', async () => {
    const res = await call(app, 'DELETE', `/auth/users/${ownId}`, { cookie });

    assert.equal(res.status, 409);
    assert.equal(
      (res.body as { error: string }).error,
      'cannot_remove_user',
    );
  });

  it('signs out every session of another user on request', async () => {
    const mate = (await listUsers()).find((user) => user.username === 'mate');
    assert.ok(mate);

    const theirs = await signIn(app, 'mate', OTHER_PASSWORD);
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: theirs.cookie })).status,
      200,
    );

    const revoked = await call(
      app,
      'POST',
      `/auth/users/${mate.id}/revoke-sessions`,
      { cookie },
    );

    assert.equal(revoked.status, 204);
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: theirs.cookie })).status,
      401,
    );
    // Ours is untouched.
    assert.equal((await call(app, 'GET', '/profiles', { cookie })).status, 200);
  });

  it('removes another user, and their sessions with them', async () => {
    const mate = (await listUsers()).find((user) => user.username === 'mate');
    assert.ok(mate);
    const theirs = await signIn(app, 'mate', OTHER_PASSWORD);

    const res = await call(app, 'DELETE', `/auth/users/${mate.id}`, { cookie });

    assert.equal(res.status, 204);
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: theirs.cookie })).status,
      401,
    );
    assert.equal((await listUsers()).length, 1);
  });

  it('answers 404 for an id that is not a user', async () => {
    const res = await call(app, 'DELETE', '/auth/users/9999', { cookie });

    assert.equal(res.status, 404);
    assert.equal((res.body as { error: string }).error, 'user_not_found');
    assert.equal((await listUsers()).length, 1);
  });

  it('changes your password, keeps this session, drops your others', async () => {
    const elsewhere = await signIn(app, USERNAME, PASSWORD);
    const next = 'yet-another-good-password';

    const wrongCurrent = await call(app, 'POST', '/auth/password', {
      cookie,
      body: { current: 'not-the-password', next },
    });
    assert.equal(wrongCurrent.status, 401);

    const changed = await call(app, 'POST', '/auth/password', {
      cookie,
      body: { current: PASSWORD, next },
    });
    assert.equal(changed.status, 204);

    assert.equal((await call(app, 'GET', '/profiles', { cookie })).status, 200);
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: elsewhere.cookie })).status,
      401,
      'the other browser should have been signed out',
    );

    const withNew = await signIn(app, USERNAME, next);
    assert.ok(withNew.cookie);
  });
});

describe('who may manage users', () => {
  let app: AuthTestApp;
  let adminCookie: string;
  let adminId: number;
  let plainCookie: string;
  let plainId: number;

  before(async () => {
    app = await startAuthTestApp();
    adminId = (await app.authService.addUser(USERNAME, PASSWORD)).id;
    plainId = (await app.authService.addUser('plain', OTHER_PASSWORD)).id;
    adminCookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
    plainCookie = (await signIn(app, 'plain', OTHER_PASSWORD)).cookie;
  });
  after(() => app.close());

  it('makes the first user an admin and the next one plain', async () => {
    const res = await call(app, 'GET', '/auth/users', { cookie: adminCookie });
    const users = res.body as UserRow[];

    assert.equal(users.find((user) => user.id === adminId)?.isAdmin, true);
    assert.equal(users.find((user) => user.id === plainId)?.isAdmin, false);
  });

  it('tells each session whether it can manage users', async () => {
    const admin = await call(app, 'GET', '/auth/session', { cookie: adminCookie });
    const plain = await call(app, 'GET', '/auth/session', { cookie: plainCookie });

    assert.equal((admin.body as { isAdmin: boolean }).isAdmin, true);
    assert.equal((plain.body as { isAdmin: boolean }).isAdmin, false);
  });

  it('identifies the same account across sessions without exposing session credentials', async () => {
    const second = await signIn(app, USERNAME, PASSWORD);
    const first = await call(app, 'GET', '/auth/session', { cookie: adminCookie });
    const repeated = await call(app, 'GET', '/auth/session', { cookie: second.cookie });
    const other = await call(app, 'GET', '/auth/session', { cookie: plainCookie });
    assert.equal((first.body as { id: number }).id, adminId);
    assert.equal((repeated.body as { id: number }).id, adminId);
    assert.equal((other.body as { id: number }).id, plainId);
    assert.notEqual(adminId, plainId);
    assert.deepEqual(Object.keys(first.body as object).sort(), ['expiresAt', 'id', 'isAdmin', 'username']);
  });

  it('refuses a plain user who tries to add or remove one', async () => {
    const added = await call(app, 'POST', '/auth/users', {
      cookie: plainCookie,
      body: { username: 'mate', password: OTHER_PASSWORD },
    });
    const removed = await call(app, 'DELETE', `/auth/users/${adminId}`, {
      cookie: plainCookie,
    });

    assert.equal(added.status, 403);
    assert.equal((added.body as { error: string }).error, 'admin_required');
    assert.equal(removed.status, 403);
  });

  it('lets a plain user sign themselves out everywhere, but nobody else', async () => {
    const other = await call(
      app,
      'POST',
      `/auth/users/${adminId}/revoke-sessions`,
      { cookie: plainCookie },
    );
    assert.equal(other.status, 403);

    const self = await call(
      app,
      'POST',
      `/auth/users/${plainId}/revoke-sessions`,
      { cookie: plainCookie },
    );
    assert.equal(self.status, 204);
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: plainCookie })).status,
      401,
    );
  });

  it('lets an admin add another admin, and refuses to remove the only one', async () => {
    const added = await call(app, 'POST', '/auth/users', {
      cookie: adminCookie,
      body: { username: 'second', password: OTHER_PASSWORD, admin: true },
    });
    assert.equal(added.status, 201);
    assert.equal((added.body as UserRow).isAdmin, true);

    // With two admins the first can go. Then the second is the only one.
    const secondId = (added.body as UserRow).id;
    await app.authService.removeUser(adminId, secondId);
    await assert.rejects(
      () => app.authService.removeUser(secondId, plainId),
      /only user who can manage users/,
    );
  });
});

// Its own app, because every case here leaves a live stream running against
// it and what one test revokes the next would otherwise inherit.
describe('an event stream whose session ends', () => {
  let app: AuthTestApp;
  let cookie: string;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
    cookie = (await signIn(app, USERNAME, PASSWORD)).cookie;
  });
  after(() => app.close());

  it('ends when that browser signs out, and no other stream with it', async () => {
    const elsewhere = await signIn(app, USERNAME, PASSWORD);
    const kept = await openEventStream(app, cookie);
    const dropped = await openEventStream(app, elsewhere.cookie);

    const out = await call(app, 'POST', '/auth/logout', {
      cookie: elsewhere.cookie,
    });

    assert.equal(out.status, 204);
    await dropped.waitForEnd();
    assert.equal((await call(app, 'GET', '/profiles', { cookie })).status, 200);
    assert.equal(kept.hasEnded(), false, 'the session that stayed keeps its stream');
    kept.close();
  });

  it('ends when an operator signs that user out everywhere', async () => {
    const mate = await app.authService.addUser('revoked', OTHER_PASSWORD);
    const theirs = await signIn(app, 'revoked', OTHER_PASSWORD);
    const stream = await openEventStream(app, theirs.cookie);

    const revoked = await call(
      app,
      'POST',
      `/auth/users/${mate.id}/revoke-sessions`,
      { cookie },
    );

    assert.equal(revoked.status, 204);
    await stream.waitForEnd();
  });

  it('ends when the user behind it is removed', async () => {
    const mate = await app.authService.addUser('removed', OTHER_PASSWORD);
    const theirs = await signIn(app, 'removed', OTHER_PASSWORD);
    const stream = await openEventStream(app, theirs.cookie);

    const removed = await call(app, 'DELETE', `/auth/users/${mate.id}`, {
      cookie,
    });

    assert.equal(removed.status, 204);
    await stream.waitForEnd();
  });

  it('ends on your other browsers when you change your password', async () => {
    await app.authService.addUser('changer', OTHER_PASSWORD);
    const here = await signIn(app, 'changer', OTHER_PASSWORD);
    const there = await signIn(app, 'changer', OTHER_PASSWORD);
    const kept = await openEventStream(app, here.cookie);
    const dropped = await openEventStream(app, there.cookie);

    const changed = await call(app, 'POST', '/auth/password', {
      cookie: here.cookie,
      body: { current: OTHER_PASSWORD, next: 'a-fine-new-password' },
    });

    assert.equal(changed.status, 204);
    await dropped.waitForEnd();
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: here.cookie })).status,
      200,
    );
    assert.equal(
      kept.hasEnded(),
      false,
      'the browser that changed it keeps its stream',
    );
    kept.close();
  });
});

// Its own app, because a session is made to run out here by editing the table
// under a stream that is already running.
describe('an event stream whose session runs out', () => {
  let app: AuthTestApp;

  before(async () => {
    app = await startAuthTestApp();
    await app.authService.addUser(USERNAME, PASSWORD);
  });
  after(() => app.close());

  const watcher = async () => {
    const session = await signIn(app, USERNAME, PASSWORD);
    return {
      cookie: session.cookie,
      tokenHash: hashSessionToken(session.token),
      stream: await openEventStream(app, session.cookie),
    };
  };

  it('is left alone by a revalidation while the session is live', async () => {
    const live = await watcher();

    assert.equal(await app.authService.closeStreamsOfEndedSessions(), 0);

    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: live.cookie })).status,
      200,
    );
    assert.equal(live.stream.hasEnded(), false);
    live.stream.close();
  });

  it('ends at the next revalidation once the session row has gone', async () => {
    const swept = await watcher();

    await app.sessions.deleteByTokenHash(swept.tokenHash);

    assert.equal(await app.authService.closeStreamsOfEndedSessions(), 1);
    await swept.stream.waitForEnd();
  });

  it('ends when the session has idled out, row still there', async () => {
    const idle = await watcher();
    const longAgo = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1_000);

    await app.sessions.touch(idle.tokenHash, longAgo);

    assert.equal(await app.authService.closeStreamsOfEndedSessions(), 1);
    await idle.stream.waitForEnd();
    assert.equal(
      (await call(app, 'GET', '/profiles', { cookie: idle.cookie })).status,
      401,
      'the gate and the revalidation should agree the session is over',
    );
  });
});
