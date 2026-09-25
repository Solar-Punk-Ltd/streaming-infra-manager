import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  measuredSrtIngest,
  SRT_BAD_DROP_PERCENT,
  SRT_INGEST_MEASURED,
  SRT_LINK_BAD,
  SRT_LINK_DEGRADED,
  SRT_LINK_HEALTHY,
  srtLinkPercentages,
  srtLinkVerdict,
  type SrtLinkCounts,
} from './srtIngestHealth.js';

const counts = (over: Partial<SrtLinkCounts> = {}): SrtLinkCounts => ({
  received: 10_000,
  lost: 0,
  retransmitted: 0,
  dropped: 0,
  ...over,
});

describe('srtLinkVerdict', () => {
  it('calls a link healthy when nothing was dropped', () => {
    assert.equal(srtLinkVerdict(counts()), SRT_LINK_HEALTHY);
  });

  // Loss that retransmission recovered in time never reached the picture.
  it('stays healthy through loss that was recovered in time', () => {
    assert.equal(
      srtLinkVerdict(counts({ lost: 900, retransmitted: 900, dropped: 0 })),
      SRT_LINK_HEALTHY,
    );
  });

  it('calls a single dropped packet degraded', () => {
    assert.equal(srtLinkVerdict(counts({ dropped: 1 })), SRT_LINK_DEGRADED);
  });

  it('stays degraded just under the bad line', () => {
    assert.equal(srtLinkVerdict(counts({ dropped: 99 })), SRT_LINK_DEGRADED);
  });

  it('calls exactly one percent dropped bad', () => {
    assert.equal(SRT_BAD_DROP_PERCENT, 1);
    assert.equal(srtLinkVerdict(counts({ dropped: 100 })), SRT_LINK_BAD);
  });

  // The two reports the tester's broadcast printed on 2026-09-22, summed.
  it('calls the broadcast that broke up for five hours bad', () => {
    assert.equal(
      srtLinkVerdict({ received: 12_957, lost: 761, retransmitted: 731, dropped: 763 }),
      SRT_LINK_BAD,
    );
  });

  it('calls a link that received nothing and dropped nothing healthy', () => {
    assert.equal(srtLinkVerdict(counts({ received: 0 })), SRT_LINK_HEALTHY);
  });

  // Every packet SRT knew of was given up on.
  it('calls a link that received nothing and dropped something bad', () => {
    assert.equal(srtLinkVerdict(counts({ received: 0, dropped: 3 })), SRT_LINK_BAD);
  });
});

describe('srtLinkPercentages', () => {
  it('gives each count as a share of the packets received', () => {
    assert.deepEqual(
      srtLinkPercentages(counts({ lost: 250, retransmitted: 200, dropped: 50 })),
      { lost: 2.5, retransmitted: 2, dropped: 0.5 },
    );
  });

  it('answers null rather than dividing by zero packets', () => {
    const percent = srtLinkPercentages(counts({ received: 0, dropped: 3 }));
    assert.deepEqual(percent, { lost: null, retransmitted: null, dropped: null });
  });

  it('answers zero for a count that is zero', () => {
    assert.deepEqual(srtLinkPercentages(counts()), {
      lost: 0,
      retransmitted: 0,
      dropped: 0,
    });
  });
});

describe('measuredSrtIngest', () => {
  it('carries the counts with the shares and the verdict worked out from them', () => {
    const reading = measuredSrtIngest({
      windowSeconds: 60,
      reports: 2,
      connections: 1,
      counts: { received: 12_957, lost: 761, retransmitted: 731, dropped: 763 },
    });

    assert.equal(reading.state, SRT_INGEST_MEASURED);
    assert.equal(reading.verdict, SRT_LINK_BAD);
    assert.equal(reading.reports, 2);
    assert.equal(reading.connections, 1);
    assert.equal(reading.windowSeconds, 60);
    assert.ok(Math.abs((reading.percent.dropped ?? 0) - 5.8887) < 0.001);
  });

  it('keeps a reading of zero packets free of anything that is not a number', () => {
    const reading = measuredSrtIngest({
      windowSeconds: 60,
      reports: 1,
      connections: 1,
      counts: counts({ received: 0 }),
    });

    assert.deepEqual(reading.percent, { lost: null, retransmitted: null, dropped: null });
    assert.doesNotMatch(JSON.stringify(reading), /NaN|Infinity/);
  });
});
