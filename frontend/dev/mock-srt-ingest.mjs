/**
 * The SRT ingest route, for the mock manager.
 *
 * It answers in the shape `manager/src/api/routes/srtIngest.ts` answers, built
 * with the shared rule the manager judges a link by, so the card can be
 * reviewed in every state offline. `?state=` picks one for a deployment and it
 * sticks, the way the uploader health's does, because the page asks again
 * every ten seconds and a state that lasted one request would flash and be
 * gone: `healthy`, `recovered`, `degraded`, `bad`, `no_reports` or
 * `unreadable`. A deployment with no srs container answers `not_running`
 * whatever was picked, and one that runs no SRS answers `not_srs`.
 */
import {
  defaultServicesFor,
  engineOfServices,
  measuredSrtIngest,
  SRS_SERVICE,
  SRT_INGEST_NO_REPORTS,
  SRT_INGEST_NOT_RUNNING,
  SRT_INGEST_NOT_SRS,
  SRT_INGEST_UNREADABLE,
} from '@streaming-infra-manager/common';

import { send } from './mock-http.mjs';

const WINDOW_SECONDS = 60;
const REPORTS_IN_A_MINUTE = 6;

/** A minute of one connection's packets, about what a 6 Mbps broadcast sends. */
const LINKS = {
  healthy: { received: 39_000, lost: 0, retransmitted: 0, dropped: 0 },
  recovered: { received: 39_000, lost: 118, retransmitted: 118, dropped: 0 },
  degraded: { received: 39_000, lost: 212, retransmitted: 190, dropped: 22 },
  // Three times the two reports the tester's broadcast printed on 2026-09-22.
  bad: { received: 38_871, lost: 2_283, retransmitted: 2_193, dropped: 2_289 },
};

const UNMEASURED = [SRT_INGEST_NO_REPORTS, SRT_INGEST_UNREADABLE];

const DEFAULT_STATE = 'healthy';

/** What each deployment was last asked to show. */
const picked = new Map();

export function srtIngestRoutes({ withProfile }) {
  return [
    [
      'GET',
      /^\/profiles\/([^/]+)\/srt-ingest$/,
      withProfile((req, res, profile) => send(res, 200, srtIngestOf(req, profile))),
    ],
  ];
}

function srtIngestOf(req, profile) {
  const asked = new URL(req.url, 'http://mock').searchParams.get('state');
  if (asked && (asked in LINKS || UNMEASURED.includes(asked))) picked.set(profile.name, asked);

  if (engineOfServices(defaultServicesFor(profile)) !== SRS_SERVICE) {
    return { state: SRT_INGEST_NOT_SRS, windowSeconds: WINDOW_SECONDS };
  }
  if (!profile.containers.some((container) => container.service === SRS_SERVICE)) {
    return { state: SRT_INGEST_NOT_RUNNING, windowSeconds: WINDOW_SECONDS };
  }

  const state = picked.get(profile.name) ?? DEFAULT_STATE;
  if (UNMEASURED.includes(state)) return { state, windowSeconds: WINDOW_SECONDS };
  return measuredSrtIngest({
    windowSeconds: WINDOW_SECONDS,
    reports: REPORTS_IN_A_MINUTE,
    connections: 1,
    counts: LINKS[state],
  });
}
