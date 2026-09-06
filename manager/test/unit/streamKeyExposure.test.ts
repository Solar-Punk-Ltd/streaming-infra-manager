/**
 * Where the stream private key goes, and where it must not.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The key signs the feed, so anyone holding it can publish as the deployment.
 * It used to travel to deploy.sh as `--private-key=0x...`, which put it in two
 * places at once: the manager's own INFO log line for the run, kept as long as
 * the logs are, and the process arguments, readable in `ps` by every user on
 * the host for as long as the script ran. It reaches the container through the
 * profile env file now, and the log line is redacted as a second control in
 * case an argument like it is ever added back.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { describeArgsForLog } from '../../src/domain/ScriptRunner.js';
import { makeProfile } from '../support/profileFixtures.js';

const root = mkdtempSync(join(tmpdir(), 'stream-key-'));
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);

const KEY = `0x${'1a'.repeat(32)}`;

describe('deploying a profile that carries a private key', () => {
  it('puts the key in the env file and nowhere in the arguments', async () => {
    const stored = makeProfile({
      name: 'stage',
      private_key: KEY,
      stamp_id: 'a'.repeat(64),
    });
    const { orchestrator, runner } = orchestratorHarness([stored]);

    await orchestrator.startDeploy(stored, undefined);

    assert.match(
      readFileSync(join(root, '.env.stage'), 'utf8'),
      new RegExp(`^STREAM_KEY=${KEY}$`, 'm'),
    );

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
