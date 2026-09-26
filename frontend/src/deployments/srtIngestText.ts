import {
  SRT_BAD_DROP_PERCENT,
  SRT_INGEST_MEASURED,
  SRT_INGEST_NO_REPORTS,
  SRT_INGEST_NOT_RUNNING,
  SRT_INGEST_NOT_SRS,
  SRT_INGEST_UNREADABLE,
  SRT_LINK_BAD,
  SRT_LINK_DEGRADED,
  SRT_LINK_HEALTHY,
  type SrtIngestMeasured,
  type SrtIngestReading,
  type SrtIngestUnmeasured,
  type SrtIngestUnmeasuredState,
  type SrtLinkVerdict,
} from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import { formatScaledPercent } from '../format';

/**
 * The words the SRT ingest card says about a reading: a verdict on a pill, a
 * sentence on what the numbers are or why there are none, the counts, and the
 * fix when the link is dropping packets.
 */

/** What the page holds: the last answer, or why there is none. */
export interface SrtIngestLoad {
  reading: SrtIngestReading | null;
  loadError: string | null;
}

export interface SrtIngestViewOptions {
  /** Whether this deployment's engine settings have an SRT latency field. */
  latencySettingOffered: boolean;
}

export interface SrtIngestRow {
  label: string;
  value: string;
  /** What the count means, in words. */
  detail: string;
}

/**
 * The one step of the remedy the card can take the operator to: the SRT
 * latency in the deployment's Stack settings card.
 */
export const RAISE_LATENCY_ACTION = 'raise-srt-latency' as const;

/** What the button of that step says. */
export const RAISE_LATENCY_BUTTON = 'Change SRT latency';

export interface SrtIngestRemedyStep {
  text: string;
  action?: typeof RAISE_LATENCY_ACTION;
}

export interface SrtIngestRemedy {
  severity: 'warning' | 'error';
  title: string;
  steps: SrtIngestRemedyStep[];
}

export interface SrtIngestView {
  pill: { label: string; tone: Tone };
  summary: string;
  rows: SrtIngestRow[];
  verdict: string | null;
  remedy: SrtIngestRemedy | null;
}

/** The engine setting the stack reads SRS's SRT latency from. */
export const SRT_LATENCY_SETTING_KEY = 'SRT_LATENCY';

/**
 * The SRT latency the manager writes when nobody has set one. SRS on a stack
 * that fills only `latency`, v3.1 among them, waits its own 120 on ingest
 * instead, so the card never tells the operator this is what they run with.
 */
const DEPLOYMENT_DEFAULT_LATENCY_MS = 2_000;

/**
 * Twice the manager's default. SRT runs at the larger of the two sides'
 * latencies, so a value at or under the deployment's own changes nothing.
 */
const SUGGESTED_LATENCY_MS = 2 * DEPLOYMENT_DEFAULT_LATENCY_MS;

/** OBS takes the SRT latency in microseconds. */
const OBS_SUGGESTED_LATENCY = SUGGESTED_LATENCY_MS * 1_000;

const VERDICT_PILL: Record<SrtLinkVerdict, SrtIngestView['pill']> = {
  [SRT_LINK_HEALTHY]: { label: 'Healthy', tone: 'ok' },
  [SRT_LINK_DEGRADED]: { label: 'Degraded', tone: 'warn' },
  [SRT_LINK_BAD]: { label: 'Bad', tone: 'err' },
};

const UNMEASURED_PILL: Record<SrtIngestUnmeasuredState, SrtIngestView['pill']> = {
  [SRT_INGEST_NO_REPORTS]: { label: 'No SRT publisher', tone: 'gray' },
  [SRT_INGEST_NOT_RUNNING]: { label: 'SRS not running', tone: 'gray' },
  [SRT_INGEST_UNREADABLE]: { label: 'Not read', tone: 'gray' },
  [SRT_INGEST_NOT_SRS]: { label: 'Not SRS', tone: 'gray' },
};

const NOT_READ_PILL: SrtIngestView['pill'] = { label: 'Not read', tone: 'gray' };
const READING_PILL: SrtIngestView['pill'] = { label: 'Reading', tone: 'info' };

export function offersLatencySetting(
  fields: readonly { key: string }[] | null | undefined,
): boolean {
  return fields?.some((field) => field.key === SRT_LATENCY_SETTING_KEY) ?? false;
}

export function srtIngestView(
  load: SrtIngestLoad,
  options: SrtIngestViewOptions,
): SrtIngestView {
  const { reading, loadError } = load;
  if (!reading) {
    return nothingToShow(
      loadError ? NOT_READ_PILL : READING_PILL,
      loadError ? `Could not ask the manager. ${loadError}` : "Reading SRS's SRT statistics.",
    );
  }
  if (reading.state === SRT_INGEST_MEASURED) return measuredView(reading, options);
  return nothingToShow(UNMEASURED_PILL[reading.state], unmeasuredSummary(reading));
}

function nothingToShow(pill: SrtIngestView['pill'], summary: string): SrtIngestView {
  return { pill, summary, rows: [], verdict: null, remedy: null };
}

function unmeasuredSummary(reading: SrtIngestUnmeasured): string {
  switch (reading.state) {
    case SRT_INGEST_NO_REPORTS:
      return (
        `SRS printed no SRT statistics in the last ${reading.windowSeconds} seconds. ` +
        'It prints them about every ten seconds while a publisher sends over SRT, so nobody is ' +
        'publishing over SRT, or a publisher connected moments ago. A broadcast over RTMP is not counted here.'
      );
    case SRT_INGEST_NOT_RUNNING:
      return 'SRS is not running, so there is no link to read.';
    case SRT_INGEST_UNREADABLE:
      return "The manager could not read SRS's log just now. The page asks again in a few seconds.";
    case SRT_INGEST_NOT_SRS:
      return 'This deployment does not run SRS, and only SRS reports these statistics.';
  }
}

function measuredView(reading: SrtIngestMeasured, options: SrtIngestViewOptions): SrtIngestView {
  const { counts, percent } = reading;
  return {
    pill: VERDICT_PILL[reading.verdict],
    summary:
      `From the ${countOf(reading.reports, 'report')} SRS printed in the last ${reading.windowSeconds} seconds, ` +
      `over ${countOf(reading.connections, 'SRT connection')}.`,
    rows: [
      { label: 'Packets received', value: formatCount(counts.received), detail: 'Data packets that reached SRS.' },
      {
        label: 'Lost',
        value: shareText(counts.lost, percent.lost),
        detail: 'Noticed missing on the way. SRT asks the broadcaster for these again.',
      },
      {
        label: 'Retransmitted',
        value: shareText(counts.retransmitted, percent.retransmitted),
        detail: 'Arrived on a second try.',
      },
      {
        label: 'Dropped',
        value: shareText(counts.dropped, percent.dropped),
        detail: 'Given up on and never delivered. These are the holes in the picture.',
      },
    ],
    verdict: verdictText(reading),
    remedy: reading.verdict === SRT_LINK_HEALTHY ? null : remedyFor(reading.verdict, options),
  };
}

function verdictText(reading: SrtIngestMeasured): string {
  switch (reading.verdict) {
    case SRT_LINK_HEALTHY:
      return reading.counts.lost === 0
        ? 'Nothing was lost and nothing was dropped.'
        : 'Nothing was dropped. Every packet that went missing was sent again in time, so the picture is whole.';
    case SRT_LINK_DEGRADED:
      return 'Some packets arrived too late to use and were dropped, so the picture can break up in places.';
    case SRT_LINK_BAD:
      return reading.counts.received === 0
        ? 'SRS gave up on packets and received none, so the picture is breaking up.'
        : `${SRT_BAD_DROP_PERCENT}% or more of the packets were dropped, so the picture is breaking up.`;
  }
}

function remedyFor(
  verdict: typeof SRT_LINK_DEGRADED | typeof SRT_LINK_BAD,
  { latencySettingOffered }: SrtIngestViewOptions,
): SrtIngestRemedy {
  const raiseLatency = `Raise the SRT latency of this deployment, to ${SUGGESTED_LATENCY_MS} ms for example`;
  return {
    severity: verdict === SRT_LINK_BAD ? 'error' : 'warning',
    title:
      "The broadcaster's connection is losing packets, and some arrive too late to use, so the picture breaks up.",
    steps: [
      latencySettingOffered
        ? { text: `${raiseLatency}, in its stack settings.`, action: RAISE_LATENCY_ACTION }
        : {
            text:
              `${raiseLatency}. Until this manager offers that setting, the change in OBS below ` +
              "does the same from the broadcaster's side.",
          },
      {
        text:
          `Or add &latency=${OBS_SUGGESTED_LATENCY} to the end of the SRT address in OBS. OBS counts ` +
          `microseconds, so that is ${SUGGESTED_LATENCY_MS / 1_000} seconds. SRT uses the larger of the two ` +
          "sides, so this only helps when it is above the SRT latency this deployment runs with.",
      },
      { text: 'Lower the bitrate OBS broadcasts at.' },
      { text: 'Use a wired connection instead of WiFi.' },
    ],
  };
}

/** A count of packets beside its share of those received, or none at all. */
function shareText(count: number, share: number | null): string {
  if (count === 0) return 'none';
  const packets = countOf(count, 'packet');
  return share === null ? packets : `${formatScaledPercent(share)} · ${packets}`;
}

function countOf(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}
