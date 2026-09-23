/**
 * A deployment's log lines read on another host, over the ssh path every other
 * read of a remote daemon takes.
 *
 * Unit test, no ssh and no Docker. `pnpm test` in manager/.
 *
 * The filter runs on the remote host, so only lines in the whole shape the
 * reader asked for cross the connection, and the read must still tell three answers apart that
 * a bare pipeline into grep cannot: no container, a container whose log said
 * nothing, and a log that could not be read. The command is also run here, in
 * a real POSIX shell against a stand-in `docker`, because a string that only
 * looks right is the failure a unit test of a string cannot catch.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ContainerNotRunningError } from '../../src/domain/errors/index.js';
import type { LogWindow } from '../../src/domain/logWindow.js';
import {
  type MarkedLines,
  remoteLogLinesCommand,
  remoteLogLinesFrom,
} from '../../src/domain/ports/remoteLogLines.js';
import { TargetDocker } from '../../src/domain/ports/TargetDocker.js';
import { TRANSPORT_STATS_HOST_PATTERN } from '../../src/domain/srtIngest/transportStatsLine.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const MARKER = '<- SRT_CPB Transport Stats # ';
const LINES: MarkedLines = { marker: MARKER, hostPattern: TRANSPORT_STATS_HOST_PATTERN };
const WINDOW: LogWindow = { sinceSeconds: 60, tailLines: 20_000 };
const REPORT =
  '[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397';
const WEBHOOK =
  '[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish ok, url=http://stream-uploader:3000/engines/srs/streams?token=abc123';
/**
 * A publisher chooses its SRT stream id and SRS quotes it into its hook lines,
 * beside the webhook token. Here the id carries the report text, and in the
 * second the id also carries a line break, so a line that begins in the exact
 * report shape goes on to the token.
 */
const QUOTING_WEBHOOK =
  `[2026-09-22 17:33:41.123][INFO][1][4ek6chsn] http: on_publish ok, stream=x${MARKER}pktRecv=1, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0, url=http://stream-uploader:3000/engines/srs/streams?token=quoted123`;
const SPLIT_WEBHOOK =
  `[2026-09-22 17:33:42.123][INFO][1][4ek6chsn] http: on_publish ok, stream=x\n[2026-09-22 17:33:42.123][INFO][1][4ek6chsn] ${MARKER}pktRecv=1, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0, url=http://stream-uploader:3000/engines/srs/streams?token=split123`;
/** SRS starts most of its console lines with a colour reset, as 67 of the 75 lines of 2026-09-22 did. */
const COLOURED_REPORT = `\u001b[0m${REPORT}`;
const CONTAINER_ID = 'c'.repeat(64);

describe('remoteLogLinesCommand', () => {
  it('asks for one service of one project, within the window, filtered on the host', () => {
    const command = remoteLogLinesCommand('stream1', 'srs', LINES, WINDOW);

    assert.match(command, /--filter 'label=com\.docker\.compose\.project=stream1'/);
    assert.match(command, /--filter 'label=com\.docker\.compose\.service=srs'/);
    assert.match(command, /docker logs --since 60s --tail 20000 "\$id"/);
    assert.ok(command.includes(`grep -E -e '${TRANSPORT_STATS_HOST_PATTERN}'`), command);
  });

  it('refuses a name or a pattern that could leave its quotes, and an empty marker', () => {
    for (const [project, service, lines] of [
      ['stream1;reboot', 'srs', LINES],
      ['$(reboot)', 'srs', LINES],
      ['stream1', "srs'", LINES],
      ['stream1', 'srs', { ...LINES, hostPattern: "it's" }],
      ['stream1', 'srs', { ...LINES, hostPattern: '' }],
      ['stream1', 'srs', { ...LINES, hostPattern: 'line\nbreak' }],
      ['stream1', 'srs', { ...LINES, hostPattern: 'bell\u0007' }],
      ['stream1', 'srs', { ...LINES, marker: '' }],
    ] as const) {
      assert.throws(
        () => remoteLogLinesCommand(project, service, lines, WINDOW),
        `${project} ${service} ${JSON.stringify(lines)}`,
      );
    }
  });

  it('refuses a window that is not a positive whole number of seconds and lines', () => {
    for (const window of [
      { sinceSeconds: 0, tailLines: 10 },
      { sinceSeconds: 60, tailLines: 0 },
      { sinceSeconds: 1.5, tailLines: 10 },
      { sinceSeconds: Number.NaN, tailLines: 10 },
    ]) {
      assert.throws(() => remoteLogLinesCommand('stream1', 'srs', LINES, window));
    }
  });
});

describe('remoteLogLinesFrom', () => {
  it('answers the marked lines of a running container that read to its end', () => {
    assert.deepEqual(
      remoteLogLinesFrom(`container=running\n${REPORT}\n${REPORT}\ndocker-logs-exit=0\n`, MARKER),
      { container: 'running', lines: [REPORT, REPORT] },
    );
  });

  it('answers a running container whose window held no marked line', () => {
    assert.deepEqual(remoteLogLinesFrom('container=running\ndocker-logs-exit=0\n', MARKER), {
      container: 'running',
      lines: [],
    });
  });

  it('answers that there is no container', () => {
    assert.deepEqual(remoteLogLinesFrom('container=none\n', MARKER), { container: 'none' });
  });

  it('refuses a log read that failed, rather than calling it empty', () => {
    assert.throws(
      () => remoteLogLinesFrom('container=running\ndocker-logs-exit=1\n', MARKER),
      /could not be read/,
    );
  });

  it('refuses an answer that stopped before its last line ended', () => {
    assert.throws(() =>
      remoteLogLinesFrom(`container=running\n${REPORT}\ndocker-logs-exit=0`, MARKER),
    );
  });

  it('refuses an answer in any other shape, and says nothing of what it held', () => {
    assert.throws(
      () => remoteLogLinesFrom(`${WEBHOOK}\n`, MARKER),
      (error: Error) => !error.message.includes('abc123'),
    );
    assert.throws(() => remoteLogLinesFrom('', MARKER));
  });

  it('keeps an unmarked line out even when the host let it through', () => {
    assert.deepEqual(
      remoteLogLinesFrom(`container=running\n${WEBHOOK}\n${REPORT}\ndocker-logs-exit=0\n`, MARKER),
      { container: 'running', lines: [REPORT] },
    );
  });
});

describe('the remote command, run by a POSIX shell', () => {
  /**
   * `docker ps` answers FAKE_IDS, `docker logs` prints FAKE_LOG in
   * FAKE_LOG_FORMAT and exits FAKE_LOGS_EXIT, and every call is appended to
   * FAKE_CALLS.
   */
  const bin = throwawayRoot('remote-log-lines-');
  const fakeDocker = join(bin, 'docker');
  writeFileSync(
    fakeDocker,
    [
      '#!/bin/sh',
      'echo "$*" >> "$FAKE_CALLS"',
      'case "$1" in',
      '  ps) [ -n "$FAKE_IDS" ] && printf \'%s\\n\' "$FAKE_IDS"; exit "${FAKE_PS_EXIT:-0}" ;;',
      '  logs) printf "${FAKE_LOG_FORMAT:-%s\\n}" "$FAKE_LOG"; exit "${FAKE_LOGS_EXIT:-0}" ;;',
      'esac',
      'exit 64',
      '',
    ].join('\n'),
  );
  chmodSync(fakeDocker, 0o755);

  function runOnHost(fake: { ids?: string; log?: string; logFormat?: string; psExit?: number; logsExit?: number }) {
    const calls = join(bin, `calls-${Math.random().toString(36).slice(2)}`);
    writeFileSync(calls, '');
    const result = spawnSync('/bin/sh', ['-c', remoteLogLinesCommand('stream1', 'srs', LINES, WINDOW)], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_CALLS: calls,
        FAKE_IDS: fake.ids ?? '',
        FAKE_LOG: fake.log ?? '',
        ...(fake.logFormat === undefined ? {} : { FAKE_LOG_FORMAT: fake.logFormat }),
        FAKE_PS_EXIT: String(fake.psExit ?? 0),
        FAKE_LOGS_EXIT: String(fake.logsExit ?? 0),
      },
    });
    return { ...result, calls };
  }

  it('hands back only the marked lines of the one container it found', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: [WEBHOOK, REPORT, 'RCV-DROPPED 1 packet(s).'].join('\n') });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(remoteLogLinesFrom(run.stdout, MARKER), { container: 'running', lines: [REPORT] });
    assert.ok(!run.stdout.includes('abc123'), 'the webhook line never left the host');
  });

  it('keeps a hook line on the host even when the stream id quotes the report', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: [QUOTING_WEBHOOK, SPLIT_WEBHOOK, COLOURED_REPORT].join('\n') });

    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes('quoted123'), 'a hook line quoting the report crossed the connection');
    assert.ok(!run.stdout.includes('split123'), 'a hook line split to begin like a report crossed the connection');
    assert.ok(run.stdout.includes(COLOURED_REPORT), 'a real report in colour codes has to cross');
  });

  it('asks for the logs of the container it found, within the window', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: REPORT });
    const logsCalls = readFileSync(run.calls, 'utf8').split('\n').filter((call) => call.startsWith('logs'));

    assert.deepEqual(logsCalls, [`logs --since 60s --tail 20000 ${CONTAINER_ID}`]);
  });

  it('reads the first of two containers rather than both run together', () => {
    const run = runOnHost({ ids: `${CONTAINER_ID}\n${'d'.repeat(64)}`, log: REPORT });
    const logsCalls = readFileSync(run.calls, 'utf8').split('\n').filter((call) => call.startsWith('logs'));

    assert.deepEqual(logsCalls, [`logs --since 60s --tail 20000 ${CONTAINER_ID}`]);
    assert.deepEqual(remoteLogLinesFrom(run.stdout, MARKER), { container: 'running', lines: [REPORT] });
  });

  it('says there is no container, and reads no log', () => {
    const run = runOnHost({ ids: '' });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(remoteLogLinesFrom(run.stdout, MARKER), { container: 'none' });
    assert.doesNotMatch(readFileSync(run.calls, 'utf8'), /^logs/m);
  });

  it('answers an empty window as an empty window, not as a failure', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: WEBHOOK });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(remoteLogLinesFrom(run.stdout, MARKER), { container: 'running', lines: [] });
  });

  it('puts the status on a line of its own after a log whose last line had no newline', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: REPORT, logFormat: '%s' });

    assert.deepEqual(remoteLogLinesFrom(run.stdout, MARKER), { container: 'running', lines: [REPORT] });
  });

  it('carries a failed log read through the pipe to the reader', () => {
    const run = runOnHost({ ids: CONTAINER_ID, log: REPORT, logsExit: 1 });

    assert.throws(() => remoteLogLinesFrom(run.stdout, MARKER), /could not be read/);
  });

  it('fails outright when the daemon cannot list its containers', () => {
    const run = runOnHost({ psExit: 1 });

    assert.notEqual(run.status, 0);
  });
});

describe('TargetDocker.logLinesContaining', () => {
  it('reads a local deployment through the local reader, and opens no ssh', async () => {
    const commands: string[] = [];
    const asked: unknown[] = [];
    const docker = new TargetDocker(
      {
        daemonId: async () => 'local-id',
        logLinesContaining: async (...args) => {
          asked.push(args);
          return [REPORT];
        },
      },
      async (file) => {
        commands.push(file);
        return '';
      },
    );

    assert.deepEqual(await docker.logLinesContaining('stream1', 'srs', LINES, WINDOW, null), [REPORT]);
    assert.deepEqual(await docker.logLinesContaining('stream1', 'srs', LINES, WINDOW, 'localhost'), [REPORT]);
    assert.deepEqual(asked, [
      ['stream1', 'srs', MARKER, WINDOW],
      ['stream1', 'srs', MARKER, WINDOW],
    ]);
    assert.deepEqual(commands, []);
  });

  it('reads a remote deployment over ssh with the same options every remote read takes', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async (file, args) => {
      calls.push({ file, args });
      return `container=running\n${REPORT}\ndocker-logs-exit=0\n`;
    });

    assert.deepEqual(await docker.logLinesContaining('stream1', 'srs', LINES, WINDOW, 'edge'), [REPORT]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, 'ssh');
    assert.deepEqual(calls[0]!.args.slice(0, 7), [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', 'edge',
    ]);
    assert.equal(calls[0]!.args[7], remoteLogLinesCommand('stream1', 'srs', LINES, WINDOW));
  });

  it('answers a remote deployment with no container the way a local one does', async () => {
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async () => 'container=none\n');

    await assert.rejects(
      () => docker.logLinesContaining('stream1', 'srs', LINES, WINDOW, 'edge'),
      ContainerNotRunningError,
    );
  });

  it('refuses a host that is not a target name before running anything', async () => {
    const commands: string[] = [];
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async (file) => {
      commands.push(file);
      return '';
    });

    await assert.rejects(() => docker.logLinesContaining('stream1', 'srs', LINES, WINDOW, 'edge;reboot'));
    assert.deepEqual(commands, []);
  });
});
