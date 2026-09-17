/**
 * Where the stream private key goes, and where it must not.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The key signs the feed, so anyone holding it can publish as the deployment,
 * for good: there is nothing to revoke. It has left by three doors.
 *
 * It used to travel to deploy.sh as `--private-key=0x...`, which put it in two
 * places at once: the manager's own INFO log line for the run, kept as long as
 * the logs are, and the process arguments, readable in `ps` by every user on
 * the host for as long as the script ran. It reaches the container through the
 * profile env file now, and the log line is redacted as a second control in
 * case an argument like it is ever added back.
 *
 * The third door was the profile row itself, which carried the key as a
 * column: every list, every read and every `profile.changed` event handed it
 * to every signed-in page. The row now says only whether a key is stored, and
 * the value is read on its own where it is written into the env file.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { describeArgsForLog } from '../../src/domain/ScriptRunner.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile } from '../support/profileFixtures.js';

const root = throwawayRoot('stream-key-');
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { orchestratorHarness, untilRunning } = await import(
  '../support/orchestratorHarness.js'
);
const { profileServiceHarness } = await import(
  '../support/profileServiceHarness.js'
);
const { createProfilesRouter } = await import(
  '../../src/api/routes/profiles.js'
);
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';
const { call, startRouterTestApp } = await import(
  '../support/routerTestApp.js'
);

const KEY = `0x${'1a'.repeat(32)}`;

describe('deploying a profile that carries a private key', () => {
  it('puts the key in the env file and nowhere in the arguments', async () => {
    const { orchestrator, runner, profiles } = orchestratorHarness([
      makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64) }),
    ]);
    await profiles.updateEditable('stage', 'streamer', { private_key: KEY });
    const stored = profiles.rows.get('stage')!;

    await orchestrator.startDeploy(stored, undefined);

    assert.match(
      readFileSync(join(root, '.env.stage'), 'utf8'),
      new RegExp(`^STREAM_KEY=${KEY}$`, 'm'),
    );
    const asSent: Record<string, unknown> = { ...stored };
    assert.equal(
      asSent.private_key,
      undefined,
      'the row the deploy ran on must not carry the key: the env writer reads it on its own',
    );
    assert.equal(stored.has_private_key, true, 'the row says a key is stored');

    const args = runner.runs[0]!.args;
    assert.ok(
      !args.some((arg) => arg.startsWith('--private-key')),
      'the key must not be a script argument',
    );
    assert.ok(
      !args.join(' ').includes(KEY),
      'the key must not appear in the arguments at all',
    );
  });
});

/** The address the key above derives, which is public and stays on the row. */
const ADDRESS = '0x1111111111111111111111111111111111111111';

describe('what a page is told about a deployment that holds a private key', () => {
  it('hears that there is one, and never hears the key', async () => {
    const harness = profileServiceHarness([]);
    const published: unknown[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'profile.changed') published.push(event.profile);
    });
    const app = await startRouterTestApp(
      createProfilesRouter(harness.service, uploaderHealthStub(), false),
      '/profiles',
    );

    try {
      const created = await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        private_key: KEY,
        public_key: ADDRESS,
      });
      assert.equal(created.status, 202, JSON.stringify(created.body));

      const list = await call(app, 'GET', '/profiles');
      const one = await call(app, 'GET', '/profiles/stage');

      const answers: [string, unknown][] = [
        ['POST /profiles', created.body],
        ['GET /profiles', list.body],
        ['GET /profiles/stage', one.body],
        ['the profile.changed events', published],
      ];
      for (const [door, body] of answers) {
        assert.ok(
          !JSON.stringify(body).includes(KEY),
          `${door} carried the signing key`,
        );
      }

      const profile = one.body as { has_private_key: boolean; public_key: string };
      assert.equal(profile.has_private_key, true, 'the page is told a key is stored');
      assert.equal(profile.public_key, ADDRESS, 'the address is public and stays');
    } finally {
      await app.close();
    }
  });

  it('keeps the stored key when a save leaves it out, because no page can send it back', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      createProfilesRouter(harness.service, uploaderHealthStub(), false),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        private_key: KEY,
        public_key: ADDRESS,
      });
      await untilRunning(harness.profiles, 'stage');

      const saved = await call(app, 'PUT', '/profiles/stage', {
        kind: 'streamer',
        notes: 'a note, and nothing about the key',
      });

      assert.equal(saved.status, 202, JSON.stringify(saved.body));
      assert.equal(
        (saved.body as { has_private_key: boolean }).has_private_key,
        true,
        'a save that says nothing about the key must not clear it',
      );
      assert.equal(await harness.profiles.privateKeyOf('stage'), KEY);
    } finally {
      await app.close();
    }
  });
});

describe('describeArgsForLog', () => {
  it('replaces the value of anything named like a secret', () => {
    assert.equal(
      describeArgsForLog([
        '--profile=stage',
        '--private-key=0xdeadbeef',
        '--srt-passphrase=hunter2',
        '--api-token=t0ken',
        '--password=letmein',
        '--client-secret=shh',
      ]),
      '--profile=stage --private-key=<redacted> --srt-passphrase=<redacted>' +
        ' --api-token=<redacted> --password=<redacted>' +
        ' --client-secret=<redacted>',
    );
  });

  it('leaves everything else readable, so a log still says what ran', () => {
    const args = [
      '--profile=stage',
      '--portSlot=2',
      '--host=localhost',
      '--stamp-id=abc',
      '--yes',
      'srs',
      'stream-uploader',
    ];
    assert.equal(describeArgsForLog(args), args.join(' '));
  });

  it('does not mistake a bare flag or a value with an equals sign in it', () => {
    assert.equal(describeArgsForLog(['--volumes']), '--volumes');
    assert.equal(
      describeArgsForLog(['--feed-topic=a=b']),
      '--feed-topic=a=b',
    );
  });
});
