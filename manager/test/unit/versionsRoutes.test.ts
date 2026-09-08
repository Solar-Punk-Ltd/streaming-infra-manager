/**
 * What the versions routes answer.
 *
 * Unit test over the real router with an in-memory table and a script runner
 * that spawns nothing. `pnpm test` in manager/.
 *
 * The shape of the add and update answers is the point. They are the only
 * routes in the manager that answer a POST with a stream, and the browser
 * cannot use EventSource for a POST, so the frontend reads the body itself. If
 * the frames stop arriving as `event: stdout` and `event: done`, the build log
 * pane goes blank and the operator has no way to tell a slow clone from a
 * failed one.
 */
import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { scratchVersionsRoot, V3_FIXTURE } from '../support/stackFixtures.js';
import {
  nextVersionChange,
  readSseFrames,
  startVersionsTestApp,
  type VersionsTestApp,
} from '../support/versionsTestApp.js';

const ROUTE_COMMIT = 'be440d65e0e82bcf9000a8a0dde905dc215255d6';

/** What the build script leaves in the attempt's staging directory, from the script's own arguments. */
function builtInStaging(args: string[]): void {
  const staging = args[1] ?? '';
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${ROUTE_COMMIT}\n`);
}

let app: VersionsTestApp;
let versionsRoot: string;

/** The commit a page showed when the operator clicked Tested. */
const SHOWN_COMMIT = 'b'.repeat(40);

beforeEach(async () => {
  versionsRoot = scratchVersionsRoot();
  app = await startVersionsTestApp(versionsRoot);
});

afterEach(() => app.close());

interface JsonAnswer {
  status: number;
  body: unknown;
}

async function callJson(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonAnswer> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/**
 * Starts a build, lets the fake script finish it, reads the whole stream, and
 * waits for the row to be written before handing back.
 */
async function build(path: string, body?: unknown, code = 0) {
  const settled = nextVersionChange(app);
  // The route spawns before it answers, so the fake has a handle by the time
  // the response headers arrive.
  const res = await fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  // A refused request answers JSON and spawns nothing, and the caller asserts
  // on that instead. Finishing a build that never started would throw here and
  // hide which assertion actually failed.
  const started = app.runner.spawned.length > 0;
  if (started) {
    if (code === 0) builtInStaging(app.runner.last.args);
    app.runner.finish(code, 'cloning\ndone\n');
  }

  const frames = await readSseFrames(res);
  if (started) await settled;
  return { res, frames };
}

describe('GET /versions', () => {
  it('answers the table, bundled first and default', async () => {
    const answer = await callJson('GET', '/versions');

    assert.equal(answer.status, 200);
    assert.deepEqual(
      (answer.body as { name: string; isDefault: boolean }[]).map((row) => [
        row.name,
        row.isDefault,
      ]),
      [['bundled', true]],
    );
  });
});

describe('POST /versions', () => {
  it('streams the build as events and ends with done', async () => {
    const { res, frames } = await build('/versions', {
      name: 'v3',
      ref: 'main-v3',
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['start', 'stdout', 'done'],
    );
    assert.match(frames[0]?.data ?? '', /stack-version-build\.sh/);
    assert.match(frames[1]?.data ?? '', /cloning/);
    assert.equal(frames[2]?.data, '{"code":0}');
  });

  it('refuses a branch git would read as an option, before any stream', async () => {
    const answer = await callJson('POST', '/versions', {
      name: 'v3',
      ref: '--upload-pack=touch',
    });

    assert.equal(answer.status, 400);
    assert.equal(app.runner.spawned.length, 0);
  });

  it('refuses a name the table already holds', async () => {
    const answer = await callJson('POST', '/versions', {
      name: 'bundled',
      ref: 'main-v2',
    });

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'stack_version_exists');
  });

  it('decides the checkout path itself, whatever the body asks for', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3', rootPath: '/etc' });

    const added = await app.repository.findByName('v3');
    assert.equal(added?.rootPath, join(versionsRoot, 'v3'));
  });
});

describe('POST /versions/:id/update', () => {
  it('streams the rebuild of an added version', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');

    const { res, frames } = await build(`/versions/${added?.id}/update`);

    assert.equal(res.status, 200);
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['start', 'stdout', 'done'],
    );
  });

  it('refuses the bundled version, which the manager deploy moves', async () => {
    const bundled = await app.repository.findByName('bundled');
    const answer = await callJson('POST', `/versions/${bundled?.id}/update`);

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'bundled_version');
  });

  it('answers 404 for an id that names nothing', async () => {
    const answer = await callJson('POST', '/versions/4242/update');
    assert.equal(answer.status, 404);
  });

  it('refuses an id that is not a number', async () => {
    const answer = await callJson('POST', '/versions/x/update');
    assert.equal(answer.status, 400);
  });
});

describe('POST /versions/:id/default', () => {
  it('answers 409 while nobody has deployed on the version', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');

    const answer = await callJson('POST', `/versions/${added?.id}/default`);
    assert.equal(answer.status, 409);
    assert.equal(
      (answer.body as { error: string }).error,
      'stack_version_untested',
    );
  });

  it('answers 204 and moves the badge', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');
    await callJson('PATCH', `/versions/${added?.id}`, {
      tested: true,
      commitSha: added?.commitSha,
    });

    const answer = await callJson('POST', `/versions/${added?.id}/default`);
    assert.equal(answer.status, 204);

    const listed = await callJson('GET', '/versions');
    assert.deepEqual(
      (listed.body as { name: string; isDefault: boolean }[])
        .filter((row) => row.isDefault)
        .map((row) => row.name),
      ['v3'],
    );
  });
});

describe('PATCH /versions/:id', () => {
  it('approves only the immutable build the page showed, including same-commit rebuilds', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const shown = (await app.repository.findByName('v3'))!;
    const rebuilt = `${shown.buildId}-r1`;
    await app.repository.publish(shown.id, { buildId: rebuilt, commitSha: shown.commitSha!, contract: shown.contract! });
    const stale = await callJson('PATCH', `/versions/${shown.id}`, { tested: true, commitSha: shown.commitSha, buildId: shown.buildId });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((await app.repository.findById(shown.id))?.tested, false);
    const current = await callJson('PATCH', `/versions/${shown.id}`, { tested: true, commitSha: shown.commitSha, buildId: rebuilt });
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal((current.body as { tested: boolean }).tested, true);
  });

  it('refuses a builds row without its shown build id and a stale click while building', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const shown = (await app.repository.findByName('v3'))!;
    for (const buildId of [undefined, null]) {
      const answer = await callJson('PATCH', `/versions/${shown.id}`, { tested: true, commitSha: shown.commitSha, buildId });
      assert.equal(answer.status, 409, JSON.stringify(answer.body));
    }
    await app.repository.markBuilding(shown.id);
    const answer = await callJson('PATCH', `/versions/${shown.id}`, { tested: true, commitSha: shown.commitSha, buildId: shown.buildId });
    assert.equal(answer.status, 400);
    assert.equal((await app.repository.findById(shown.id))?.tested, false);
  });

  it('does not treat a legacy row as an immutable build named by a caller', async () => {
    const bundled = (await app.repository.findByName('bundled'))!;
    await app.repository.setCommitSha(bundled.id, SHOWN_COMMIT);
    const answer = await callJson('PATCH', `/versions/${bundled.id}`, { tested: true, commitSha: SHOWN_COMMIT, buildId: SHOWN_COMMIT });
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.equal((await app.repository.findById(bundled.id))?.tested, false);
  });

  it('approves the commit the page showed, and answers the row', async () => {
    const bundled = await app.repository.findByName('bundled');
    await app.repository.setCommitSha(bundled?.id ?? 0, SHOWN_COMMIT);

    const answer = await callJson('PATCH', `/versions/${bundled?.id}`, {
      tested: true,
      commitSha: SHOWN_COMMIT,
    });

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal((answer.body as { tested: boolean }).tested, true);
  });

  it('refuses a click made for a commit the version has moved past, and changes nothing', async () => {
    const bundled = await app.repository.findByName('bundled');
    await app.repository.setCommitSha(bundled?.id ?? 0, 'e'.repeat(40));

    const answer = await callJson('PATCH', `/versions/${bundled?.id}`, {
      tested: true,
      commitSha: SHOWN_COMMIT,
    });

    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.equal((answer.body as { error: string }).error, 'stack_version_changed');
    assert.equal((await app.repository.findByName('bundled'))?.tested, false);
  });

  it('refuses to approve a version at a commit this host cannot tell', async () => {
    const bundled = await app.repository.findByName('bundled');

    const answer = await callJson('PATCH', `/versions/${bundled?.id}`, {
      tested: true,
      commitSha: SHOWN_COMMIT,
    });
    const body = answer.body as { errors?: string[] };

    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.match(body.errors?.[0] ?? '', /cannot tell/);
  });

  it('refuses to approve without naming the commit, left out or null', async () => {
    const bundled = await app.repository.findByName('bundled');
    await app.repository.setCommitSha(bundled?.id ?? 0, SHOWN_COMMIT);

    const leftOut = await callJson('PATCH', `/versions/${bundled?.id}`, { tested: true });
    const asNull = await callJson('PATCH', `/versions/${bundled?.id}`, {
      tested: true,
      commitSha: null,
    });

    assert.equal(leftOut.status, 400, JSON.stringify(leftOut.body));
    assert.equal(asNull.status, 400, JSON.stringify(asNull.body));
    assert.equal((await app.repository.findByName('bundled'))?.tested, false);
  });

  it('refuses a body with no tested flag', async () => {
    const bundled = await app.repository.findByName('bundled');
    const answer = await callJson('PATCH', `/versions/${bundled?.id}`, {});

    assert.equal(answer.status, 400);
  });

  it('answers 400 for a version whose build failed, with the reason', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' }, 1);
    const failed = await app.repository.findByName('v3');

    const answer = await callJson('PATCH', `/versions/${failed?.id}`, {
      tested: true,
      commitSha: SHOWN_COMMIT,
    });
    const body = answer.body as { error: string; errors: string[] };

    assert.equal(answer.status, 400);
    assert.equal(body.error, 'validation_error');
    assert.match(body.errors[0] ?? '', /finished building can be marked/);
  });

  it('clears the flag on a version that is not ready', async () => {
    const bundled = await app.repository.findByName('bundled');
    await app.repository.markFailed(bundled?.id ?? 0, 'boom');

    const answer = await callJson('PATCH', `/versions/${bundled?.id}`, {
      tested: false,
    });

    assert.equal(answer.status, 200);
    assert.equal((answer.body as { tested: boolean }).tested, false);
  });
});

describe('DELETE /versions/:id', () => {
  it('answers 204 for a version nothing runs', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');

    const answer = await callJson('DELETE', `/versions/${added?.id}`);
    assert.equal(answer.status, 204);
    assert.equal(await app.repository.findByName('v3'), null);
  });

  it('answers 409 with the deployment names while it is in use', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');
    app.repository.setDeployments(added?.id ?? 0, ['main-stage', 'viewer-eu']);

    const answer = await callJson('DELETE', `/versions/${added?.id}`);
    const body = answer.body as { error: string; deployments: string[] };

    assert.equal(answer.status, 409);
    assert.equal(body.error, 'stack_version_in_use');
    assert.deepEqual(body.deployments, ['main-stage', 'viewer-eu']);
  });

  it('answers 409 for the version that is the default', async () => {
    await build('/versions', { name: 'v3', ref: 'main-v3' });
    const added = await app.repository.findByName('v3');
    await callJson('PATCH', `/versions/${added?.id}`, {
      tested: true,
      commitSha: added?.commitSha,
    });
    await callJson('POST', `/versions/${added?.id}/default`);

    const answer = await callJson('DELETE', `/versions/${added?.id}`);

    assert.equal(answer.status, 409);
    assert.equal(
      (answer.body as { error: string }).error,
      'stack_version_is_default',
    );
  });

  it('answers 409 for the bundled version', async () => {
    const bundled = await app.repository.findByName('bundled');
    const answer = await callJson('DELETE', `/versions/${bundled?.id}`);

    assert.equal(answer.status, 409);
    assert.equal((answer.body as { error: string }).error, 'bundled_version');
  });
});
