import { describe, it } from 'node:test';

/**
 * Scenario F — uploader restart mid-stream (SRS engine). PARKED as a documented `todo`.
 *
 * Live investigation (2026-07-06) showed the current system does NOT resume the same live stream
 * across a stream-uploader restart when the media engine is SRS:
 *
 *   - Graceful restart (docker restart → SIGTERM): the shutdown handler drains + finalizes the
 *     stream as a VOD and removes the RecoveryStore entry. On reboot: "No streams to recover".
 *     SRS keeps POSTing segments but never re-sends `on_publish`, so `startStream` is never called
 *     → the stream is not in activeStreams → every segment is rejected as `unknown_stream` and
 *     dropped. The live stream is effectively over until the broadcaster reconnects.
 *
 *   - Hard crash (docker kill → SIGKILL): the RecoveryStore entry survives, so `recoverStreams`
 *     restores the stream into activeStreams with a 60s "wait for engine reconnect" timer. Uploads
 *     DO resume (on_hls → handleSegment finds the recovered stream), but nothing cancels that timer
 *     (only `on_publish`/startStream does, which SRS never re-sends) → ~60s later it VODs and stops.
 *
 * Root cause is PRE-EXISTING (not PR #10): recovery assumes the engine re-announces the stream after
 * a restart. The OME puller re-pulls; the SRS push engine sends `on_publish` only once per broadcaster
 * session (see engines/srs.ts — `handleStreams` calls startStream only on on_publish; `handleHls`
 * only calls handleSegment). A fix (adopt/revive a recovered stream on the first on_hls, or cancel
 * the recovery timer when segments flow) belongs in its own ticket. The harness (publisher + host +
 * logwatch) is ready to turn this into a behavioral test once the resume path is defined.
 */
describe('F — uploader restart mid-stream (SRS engine)', () => {
  it.todo('resume the same live SRS stream across an uploader restart (not supported yet — see comment)');
});
