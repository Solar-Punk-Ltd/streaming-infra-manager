/**
 * The parts of the integration client that decide whether it may run and
 * what it sends, tested without a manager.
 *
 * Unit test, no network. `pnpm test` in manager/.
 *
 * The suite creates and removes deployments, so whether it starts at all is
 * the guard that keeps it off a host with funded deployments on it, and the
 * cookie and the write header are what the manager refuses everything
 * without.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requestHeaders, sessionCookieFrom } from '../integration/session.js';
import {
  belongsToRun,
  runIdFrom,
  runName,
  targetProblem,
} from '../integration/target.js';

/** What `op run --env-file` puts in the environment, with dummies for the pair. */
const DECLARED = {
  MANAGER_URL: 'http://localhost:9876',
  MANAGER_TEST_TARGET: 'http://localhost:9876',
  MANAGER_TEST_USERNAME: 'itest',
  MANAGER_TEST_PASSWORD: 'dummy-pair-half',
};

/** The rule a deployment name has to pass, from common/src, as the API applies it. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

describe('whether the suite may start', () => {
  it('starts when the target is declared and the sign-in is there', () => {
    assert.equal(targetProblem(DECLARED), null);
  });

  it('refuses when nothing declares the manager a test target', () => {
    const { MANAGER_TEST_TARGET: _dropped, ...env } = DECLARED;

    const problem = targetProblem(env);

    assert.match(problem ?? '', /MANAGER_TEST_TARGET is not set/);
    assert.match(problem ?? '', /http:\/\/localhost:9876/, 'names the manager it would run against');
  });

  it('refuses when the declaration names a different manager', () => {
    const problem = targetProblem({
      ...DECLARED,
      MANAGER_URL: 'http://157.90.34.105:9876',
    });

    assert.match(problem ?? '', /MANAGER_TEST_TARGET names a different manager/);
  });

  it('reads a trailing slash and letter case as the same manager', () => {
    assert.equal(
      targetProblem({ ...DECLARED, MANAGER_TEST_TARGET: 'HTTP://localhost:9876/' }),
      null,
    );
  });

  it('checks the declaration against the default URL when MANAGER_URL is unset', () => {
    const { MANAGER_URL: _dropped, ...env } = DECLARED;

    assert.equal(targetProblem(env), null);
    assert.match(
      targetProblem({ ...env, MANAGER_TEST_TARGET: 'http://localhost:1' }) ?? '',
      /different manager/,
    );
  });

  it('refuses without both halves of the sign-in, naming the variables and never a value', () => {
    const { MANAGER_TEST_PASSWORD: _dropped, ...env } = DECLARED;

    const problem = targetProblem(env) ?? '';

    assert.match(problem, /MANAGER_TEST_USERNAME and MANAGER_TEST_PASSWORD/);
    assert.match(problem, /op run --env-file/);
    assert.equal(problem.includes('itest'), false, 'no value in the message');
  });
});

describe('the names a run makes', () => {
  it('carry the prefix, the run and the base, and pass the deployment name rule', () => {
    const name = runName('ab12z', 'streamer');

    assert.match(name, /^itest-ab12z-streamer-[a-z0-9]{4}$/);
    assert.match(name, PROFILE_NAME_RE);
  });

  it('leave room for the rung suffix of a ladder pool', () => {
    // A pool member is `<pool>-<rung>`, and `1080p` is the longest rung.
    assert.ok(`${runName('ab12z', 'pool')}-1080p`.length <= 31);
  });

  it('differ from one another within a run', () => {
    assert.notEqual(runName('ab12z', 'grp'), runName('ab12z', 'grp'));
  });

  it('take the run id from the environment, so separate suite processes share one', () => {
    assert.equal(runIdFrom({ MANAGER_TEST_RUN: 'nightly1' }), 'nightly1');
  });

  it('refuse a run id that could not go into a deployment name', () => {
    assert.throws(() => runIdFrom({ MANAGER_TEST_RUN: 'Nightly_1' }), /MANAGER_TEST_RUN/);
  });

  it('make a run id of their own otherwise', () => {
    assert.match(runIdFrom({}), /^[a-z0-9]{5}$/);
  });

  it('are the only names cleanup may remove', () => {
    assert.equal(belongsToRun('ab12z', 'itest-ab12z-viewer-q1w2'), true);
    assert.equal(belongsToRun('ab12z', 'itest-zz999-viewer-q1w2'), false, 'another run');
    assert.equal(belongsToRun('ab12z', 'itest-viewer-q1w2'), false, 'the old scheme');
    assert.equal(belongsToRun('ab12z', 'review-20260907'), false, 'never');
  });
});

describe('the session cookie', () => {
  it('is picked out of the sign-in answer, ready for the Cookie header', () => {
    const cookie = sessionCookieFrom([
      'other=1; Path=/',
      'sim_session=tok3n; Path=/; HttpOnly; SameSite=Lax',
    ]);

    assert.equal(cookie, 'sim_session=tok3n');
  });

  it('is null when the answer cleared it, or set none', () => {
    assert.equal(
      sessionCookieFrom(['sim_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
      null,
    );
    assert.equal(sessionCookieFrom([]), null);
  });
});

describe('what a request carries', () => {
  it('sends the cookie on a read and nothing else', () => {
    assert.deepEqual(requestHeaders({ method: 'GET', cookie: 'sim_session=t', hasBody: false }), {
      cookie: 'sim_session=t',
    });
  });

  it('sends the cookie, the write header and the content type on a write with a body', () => {
    assert.deepEqual(requestHeaders({ method: 'POST', cookie: 'sim_session=t', hasBody: true }), {
      cookie: 'sim_session=t',
      'x-requested-with': 'streaming-infra-manager',
      'content-type': 'application/json',
    });
  });

  it('sends the write header on DELETE too, and not on HEAD', () => {
    assert.equal(
      requestHeaders({ method: 'DELETE', cookie: null, hasBody: false })['x-requested-with'],
      'streaming-infra-manager',
    );
    assert.deepEqual(requestHeaders({ method: 'HEAD', cookie: null, hasBody: false }), {});
  });

  it('leaves the write header out only when a test asks it to', () => {
    const headers = requestHeaders({
      method: 'POST',
      cookie: 'sim_session=t',
      hasBody: true,
      requestedWith: false,
    });

    assert.equal('x-requested-with' in headers, false);
    assert.equal(headers.cookie, 'sim_session=t');
  });

  it('sends no cookie when signed out', () => {
    assert.equal('cookie' in requestHeaders({ method: 'GET', cookie: null, hasBody: false }), false);
  });
});
