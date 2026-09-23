/**
 * SRS's SRT statistics line, read out of a log that carries secrets beside it.
 *
 * Unit test, no Docker and no SRS. `pnpm test` in manager/.
 *
 * The two report lines are real, from the tester's broadcast of 2026-09-22 that
 * came out with broken blocks of picture for five hours. The rest of the log
 * here is what sits around them on a live host: libsrt's drop warnings, the
 * viewer side's own statistics, the webhook line that carries the uploader's
 * token, and the line that names the publisher's address. Only the first kind
 * may produce anything.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  parseTransportStatsLine,
  parseTransportStatsLines,
  TRANSPORT_STATS_HOST_PATTERN,
  TRANSPORT_STATS_MARKER,
} from '../../src/domain/srtIngest/transportStatsLine.js';

const FIRST =
  '[2026-09-22 17:33:50.386][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6500, pktRcvLoss=394, pktRcvRetrans=381, pktRcvDrop=397';
const SECOND =
  '[2026-09-22 17:34:00.410][INFO][1][4ek6chsn] <- SRT_CPB Transport Stats # pktRecv=6457, pktRcvLoss=367, pktRcvRetrans=350, pktRcvDrop=366';

const ESC = '\u001b';

describe('parseTransportStatsLine', () => {
  it('reads the four counts and the connection off a real line', () => {
    assert.deepEqual(parseTransportStatsLine(FIRST), {
      connection: '4ek6chsn',
      counts: { received: 6500, lost: 394, retransmitted: 381, dropped: 397 },
    });
  });

  it('reads the line through the colour codes SRS writes around it', () => {
    for (const coloured of [
      `${ESC}[0m${SECOND}`,
      `${SECOND}${ESC}[0m`,
      `${ESC}[33m${SECOND}${ESC}[0m`,
      `${ESC}[0m${ESC}[1;32m${SECOND}${ESC}[0m`,
    ]) {
      assert.deepEqual(parseTransportStatsLine(coloured)?.counts, {
        received: 6457,
        lost: 367,
        retransmitted: 350,
        dropped: 366,
      });
    }
  });

  it('reads a line that ended in a carriage return', () => {
    assert.equal(parseTransportStatsLine(`${FIRST}\r`)?.counts.received, 6500);
  });

  it('reads the older level word SRS used for the same line', () => {
    assert.equal(
      parseTransportStatsLine(FIRST.replace('[INFO]', '[Trace]'))?.connection,
      '4ek6chsn',
    );
  });

  it('refuses a line cut in half anywhere before its last count', () => {
    for (const cut of [
      FIRST.slice(0, FIRST.indexOf('pktRcvLoss') + 6),
      FIRST.slice(0, FIRST.indexOf('pktRcvDrop=') + 'pktRcvDrop='.length),
      FIRST.slice(FIRST.indexOf('<- SRT_CPB')),
      FIRST.slice(10),
    ]) {
      assert.equal(parseTransportStatsLine(cut), null, cut);
    }
  });

  it('refuses the viewer side of the link, which counts what SRS sent', () => {
    assert.equal(
      parseTransportStatsLine(
        '[2026-09-22 17:33:51.001][INFO][1][9wq2m1xy] -> SRT_PLAY Transport Stats # pktSent=6400, pktSndLoss=0, pktRetrans=0, pktSndDrop=0',
      ),
      null,
    );
  });

  it("refuses libsrt's drop warnings, which flood the same log", () => {
    assert.equal(
      parseTransportStatsLine(
        `${ESC}[33m[2026-09-22 17:33:50.901][WARN][1][4ek6chsn] RCV-DROPPED 1 packet(s). Packet seqno %861816580 delayed for 4.5 ms${ESC}[0m`,
      ),
      null,
    );
  });

  it('refuses a count too long to be a number exactly, or a negative one', () => {
    assert.equal(
      parseTransportStatsLine(FIRST.replace('pktRecv=6500', 'pktRecv=12345678901234567')),
      null,
    );
    assert.equal(parseTransportStatsLine(FIRST.replace('pktRcvDrop=397', 'pktRcvDrop=-1')), null);
  });

  it('refuses the report text anywhere but at the start of a message', () => {
    // A publisher chooses its own stream id and SRS quotes it, so the text of
    // a report can turn up inside a line that is not one.
    assert.equal(
      parseTransportStatsLine(
        `[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish url=http://stream-uploader:3000/engines/srs/streams?token=abc123 ${FIRST.slice(FIRST.indexOf('<-'))}`,
      ),
      null,
    );
    assert.equal(parseTransportStatsLine(`${FIRST}, token=abc123`), null);
  });

  it('refuses a whole report line quoted at the end of another line', () => {
    assert.equal(
      parseTransportStatsLine(
        `[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] srt: streamid=#!::r=live/${FIRST}`,
      ),
      null,
    );
  });

  it('keeps the marker a reader filters on inside every line it reads', () => {
    assert.ok(FIRST.includes(TRANSPORT_STATS_MARKER));
  });
});

describe('parseTransportStatsLines', () => {
  const LOG = [
    `${ESC}[0m[2026-09-22 17:33:40.101][INFO][1][4ek6chsn] SRT: publish stream=live/stream, peer ip=203.0.113.7:51514`,
    '[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish ok, client_id=4ek6chsn, url=http://stream-uploader:3000/engines/srs/streams?token=abc123, request={"action":"on_publish"}, response={"code":0}',
    FIRST,
    `${ESC}[33m[2026-09-22 17:33:50.901][WARN][1][4ek6chsn] RCV-DROPPED 1 packet(s). Packet seqno %861816580 delayed for 4.5 ms${ESC}[0m`,
    '[2026-09-22 17:33:55.200][INFO][1][7hd0ka2p] <- SRT_CPB Transport Stats # pktRecv=900, pktRcvLoss=0, pktRcvRetrans=0, pktRcvDrop=0',
    SECOND,
  ];

  it('keeps the reports in the order they were written, of every connection', () => {
    assert.deepEqual(
      parseTransportStatsLines(LOG).map((report) => [report.connection, report.counts.received]),
      [
        ['4ek6chsn', 6500],
        ['7hd0ka2p', 900],
        ['4ek6chsn', 6457],
      ],
    );
  });

  it('hands on no text from the log but the connection a report came from', () => {
    const reports = parseTransportStatsLines(LOG);
    const text = JSON.stringify(reports);

    for (const secret of ['abc123', 'token', '203.0.113.7', 'stream-uploader', 'RCV-DROPPED']) {
      assert.ok(!text.includes(secret), `${secret} reached the parsed reports`);
    }
    for (const report of reports) {
      assert.deepEqual(Object.keys(report).sort(), ['connection', 'counts']);
      assert.ok(Object.values(report.counts).every(Number.isSafeInteger));
    }
  });

  it('finds nothing in a log with no report in it', () => {
    assert.deepEqual(parseTransportStatsLines(LOG.filter((line) => !line.includes('Transport'))), []);
    assert.deepEqual(parseTransportStatsLines([]), []);
  });
});

describe('the pattern a remote reader filters with, run by grep', () => {
  /** Lines through the host's own `grep -E`, which is what runs on the remote host. */
  function keptByGrep(lines: readonly string[]): string[] {
    const run = spawnSync('grep', ['-E', '-e', TRANSPORT_STATS_HOST_PATTERN], {
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
    return run.stdout.split('\n').filter((line) => line !== '');
  }

  it('keeps exactly the lines the parser reads', () => {
    const lines = [
      FIRST,
      SECOND,
      `${ESC}[0m${SECOND}`,
      `${SECOND}${ESC}[0m`,
      `${ESC}[33m${SECOND}${ESC}[0m`,
      `${ESC}[0m${ESC}[1;32m${SECOND}${ESC}[0m`,
      `${FIRST}\r`,
      FIRST.replace('[INFO]', '[Trace]'),
      FIRST.slice(0, FIRST.indexOf('pktRcvDrop=') + 'pktRcvDrop='.length),
      '[2026-09-22 17:33:51.001][INFO][1][9wq2m1xy] -> SRT_PLAY Transport Stats # pktSent=6400, pktSndLoss=0, pktRetrans=0, pktSndDrop=0',
      `[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] http: on_publish url=http://stream-uploader:3000/engines/srs/streams?token=abc123 ${FIRST.slice(FIRST.indexOf('<-'))}`,
      `${FIRST}, token=abc123`,
      `[2026-09-22 17:33:40.123][INFO][1][4ek6chsn] srt: streamid=#!::r=live/${FIRST}`,
      FIRST.replace('pktRecv=6500', 'pktRecv=12345678901234567'),
      FIRST.replace('pktRcvDrop=397', 'pktRcvDrop=-1'),
    ];
    const read = lines.filter((line) => parseTransportStatsLine(line) !== null);

    assert.equal(read.length, 8, 'the eight lines the parser reads, as its own cases above say');
    assert.deepEqual(keptByGrep(lines), read);
  });
});
