# SRS accepted-media durability

Status: active implementation brief under R04 of the registered SRS continuation plan.
Date: 2026-09-20.
Owner: OpenAI-hosted Astra.

This brief fixes the meaning of accepted media for the implementation handoff. It adds no new product feature. The reviewed plan already requires accepted footage to survive an uploader crash, including footage whose uploads have all failed.

## Acceptance boundary

An engine callback is accepted when the uploader acknowledges taking responsibility for its segment. This happens before Bee has necessarily answered. Persisting only the returned Bee reference cannot protect an in-memory upload queue.

For lifecycle version 1, persist the original segment bytes and their stream, run, source-generation, rendition and sequence identity before acknowledging acceptance. Include duration and any seam or header information needed to place that segment correctly after recovery. A repeated identity with identical content is an idempotent retry. Different content under the same identity is refused. Never acknowledge a failed file or directory flush.

Admission and durable acceptance must agree. Recheck the current source and deadline before committing acceptance. A callback that arrived before the deadline but had not been accepted at cutoff cannot silently renew an expired run. Once a segment is durably accepted, closing admission must not discard it.

The extra ABR base/source HLS is observation-only, as specified in the lifecycle contract. Its duplicate footage is not part of the published recording and must not be inserted into the Bee upload queue or counted as accepted recording media. Persist the progress/deadline evidence required by restart recovery before acknowledging an observation. Retain a bounded opening sample until actual-format validation succeeds and its fingerprint is durably bound to that source generation. Later observation-only bytes can be discarded after validation. Every published rung, and the source in single-rendition mode, still uses the full accepted-media boundary above.

## Upload and recovery boundary

Keep raw accepted bytes until their uploaded reference and placement in recoverable history are durably recorded. A successful upload alone is not that record. An upload failure leaves recoverable work. It cannot produce a verified-empty outcome or a completed VOD.

Recovery first reconciles retained history and pending work, then resumes or finalizes under the original durable admission deadline. A restart does not grant another reconnect window. Replaying a queued record is idempotent by its persistent identity. Existing published references are reused during continuation rather than uploading the preceding recording again.

The existing `RecoveryStore.save` uses temporary-file replacement without file or directory flushes. It is not evidence of acknowledged durability. The worker may add a managed store or strengthen the needed existing path, but must show the actual acceptance and cleanup paths use it. Keep durable closed records and continuation checkpoints outside ordinary recovery cleanup.

## Checkpoint boundary

Finalize only after every accepted segment is accounted for. Retain a complete checkpoint before reporting VOD. It binds the master and every expected rendition, their exact published references and indices, cumulative history, format compatibility and the next writable feed position. Failed finalization preserves the previous verified replay and pending work.

Continue prepares from that checkpoint under the same stable feed topics and a new run number. It waits for every predecessor writer to finish. It appends a marked seam, preserves earlier media and publishes a new cumulative final recording. It never edits the old immutable final manifest bytes or treats an incomplete ladder as complete.

## Smallest required regressions

1. A callback is acknowledged while Bee remains unavailable. Kill the process, recover from disk and prove the exact bytes remain available for one logical segment.
2. Fail the byte-file flush, metadata replacement and directory flush independently. Each path refuses acknowledgement and cannot claim successful empty finalization.
3. Crash after upload acknowledgement but before history commitment, then after history commitment but before raw-byte cleanup. Recovery neither loses the segment nor appends it twice.
4. Retry the same callback before and after restart. Identical content is deduplicated and conflicting content is refused.
5. Close while uploads are pending. No new source media is admitted, retained work survives, and VOD is withheld until complete.
6. Finalize A, continue B in a fresh process, then continue C. Final history is A+B+C with stable old master and rung references. A missing expected rung refuses completion.
7. Fail the final feed write, checkpoint save and report acknowledgement separately. Restart retains one recoverable result and does not turn an ambiguous response into a fresh publication.

Focused storage and orchestration checks precede the isolated real-media crash and decode runs. Process-kill evidence is reported as process-crash evidence, not as a hardware power-loss test.
