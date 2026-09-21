# Persist SRS broadcast runs and explicit continuation

Status: active. Published as draft PR https://github.com/Solar-Punk-Ltd/streaming-monorepo/pull/8. Not ready to merge.
Target: `Solar-Punk-Ltd/streaming-monorepo`, `master`.

An encoder disconnect now leaves its managed broadcast waiting under the uploader's original sixty-second deadline. Once the deadline expires, that run closes and the ingest ID stays closed until its owner explicitly chooses Continue. Continuation retains the previous playable replay and records a new run that will extend the cumulative recording.

The admin stores run permission, uploader assignment, ordered reports and immutable completed master/rendition snapshots. Stream locks serialize claims, continuation, preparation and cancellation. Idempotent request identities let the UI recover a committed result after response loss. Older completed recordings use a separate verification step before becoming eligible to continue.

Enrollment stays disabled until the configured uploader and compatible release receipts are ready. Existing active legacy streams retain their current contract. Forward database guards refuse old write paths against managed history.

Companions: stack reconnect/media/viewer changes and manager observation/release integration. Final checked commits remain required before readiness. Default branches and live services are not changed by this PR.

Validation recorded so far includes full lint, typechecking, common/frontend/backend unit suites and 106 PostgreSQL tests at `e8058860d6be3e512bd4cd5cc3b86ffd21b54ea8`. Later commits have focused controlled database overlaps for claims, Continue, cancel, reports, catalogue snapshots and older-recording preparation. These older full-suite results do not establish the final candidate.

Before readiness: final candidate full checks, owner-control browser checks, assembled uploader/media validation, incompatible-release refusals and the separately coordinated OBS/real-Swarm acceptance case. The exact evidence inventory is maintained with the manager companion in `docs/testing/srs-continuation/validation-inventory.md`.

Managed unpublish also rechecks the current run before hiding it. If a live successor appeared during the catalogue write, it restores the current entry and reports that the stream is active. Focused evidence includes 58 PublishService cases and four real PostgreSQL visibility cases. The latter explicitly holds a lifecycle transaction open until a competing hide waits on its stream-row lock. Later UI and legacy-adoption checks passed 29 and seven cases respectively. These results are recorded through admin candidate `720efec9bf01fbe189fb73bfb302de4e8d77a7fa` and do not replace the pending final full run.

Companion drafts: [stack #242](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/242), [admin #8](https://github.com/Solar-Punk-Ltd/streaming-monorepo/pull/8), [manager #43](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/pull/43).
