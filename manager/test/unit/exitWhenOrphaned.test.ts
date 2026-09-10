/**
 * What a forked fixture does when the process that started it dies without
 * saying so.
 *
 * The connected browser suite forks the manager in test/support/
 * connectedChequebookServer.ts and ends it by closing the IPC channel. That
 * covers a parent that ends its own children. It does not cover a parent that
 * is killed, whose channel closing is never noticed, or whose own cleanup
 * throws before it gets there: the fork then sits in the runner holding a
 * PostgreSQL schema until the job's own limit. The browser job's first run
 * ended with a Chrome, two crashpad handlers and several node processes in the
 * runner's orphan list.
 *
 * The child below is orphaned the way that happens on a runner: its parent is
 * killed outright, with no disconnect and no signal of its own.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WATCHDOG_URL = new URL('../support/exitWhenOrphaned.mjs', import.meta.url).href;
const SERVER_FILE = fileURLToPath(new URL('../support/connectedChequebookServer.ts', import.meta.url));
const POLL_MS = 100;
const GIVE_UP_MS = 15_000;

/** Arms the watchdog, then holds the event loop open the way a listening server would. */
const ORPHAN = `
  const { exitWhenOrphaned } = await import(${JSON.stringify(WATCHDOG_URL)});
  const { writeFileSync } = await import('node:fs');
  setInterval(() => {}, 1000);
  exitWhenOrphaned(() => process.exit(0), ${POLL_MS});
  writeFileSync(process.argv[1] + '/armed', String(process.pid));
`;

/** The parent that will be killed. It reports the pid to watch and then does nothing. */
const PARENT = `
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', process.argv[2], process.argv[1]], { stdio: 'ignore' });
  process.stdout.write(String(child.pid) + '\\n');
  setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(satisfied: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + GIVE_UP_MS;
  while (Date.now() < deadline) {
    if (satisfied()) return;
    await new Promise(resolve => { setTimeout(resolve, POLL_MS); });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe('a fixture whose parent is gone', () => {
  it('ends itself rather than outliving the job', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'orphan-watchdog-'));
    const parent = spawn(process.execPath, ['--input-type=module', '-e', PARENT, directory, ORPHAN],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let reported = '';
    let orphan = 0;
    parent.stdout.on('data', chunk => { reported += chunk; });
    t.after(async () => {
      parent.kill('SIGKILL');
      if (orphan > 0 && alive(orphan)) process.kill(orphan, 'SIGKILL');
      await rm(directory, { recursive: true, force: true });
    });

    await until(() => reported.includes('\n'), 'the parent to report the pid of the child it started');
    orphan = Number(reported.trim());
    await until(() => existsSync(join(directory, 'armed')), 'the child to arm its watchdog');
    assert.equal(alive(orphan), true, 'the child is running before its parent is killed');
    assert.equal(await readFile(join(directory, 'armed'), 'utf8'), String(orphan), 'and it is the child that armed it');

    parent.kill('SIGKILL');

    await until(() => !alive(orphan), `the orphaned child ${orphan} to end itself`);
  });

  it('is armed by the connected browser fixture, which is the fork that would be left', async () => {
    const source = await readFile(SERVER_FILE, 'utf8');

    assert.match(source, /exitWhenOrphaned\(/, 'the connected fixture arms the watchdog');
    assert.match(source, /process\.on\('disconnect'/, 'and still ends on the channel its parent closes');
  });
});
