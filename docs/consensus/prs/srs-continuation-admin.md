# Persist SRS broadcast runs and explicit continuation

Status: active local PR draft. Not published. Implementation and assembled validation remain in progress.
Target: `Solar-Punk-Ltd/streaming-monorepo`, `master`.

An encoder disconnect now leaves its managed broadcast waiting under the uploader's original sixty-second deadline. Once the deadline expires, that run closes and the ingest ID stays closed until its owner explicitly chooses Continue. Continuation retains the previous playable replay and records a new run that will extend the cumulative recording.

The admin stores run permission, uploader assignment, ordered reports and immutable completed master/rendition snapshots. Stream locks serialize claims, continuation, preparation and cancellation. Idempotent request identities let the UI recover a committed result after response loss. Older completed recordings use a separate verification step before becoming eligible to continue.

Enrollment stays disabled until the configured uploader and compatible release receipts are ready. Existing active legacy streams retain their current contract. Forward database guards refuse old write paths against managed history.

Companions: stack reconnect/media/viewer changes and manager observation/release integration. Add the three PR links and exact checked commits before publication. Default branches and live services are not changed by this PR.

Validation recorded so far includes full lint, typechecking, common/frontend/backend unit suites and 106 PostgreSQL tests at `e8058860d6be3e512bd4cd5cc3b86ffd21b54ea8`. Later commits have focused controlled database overlaps for claims, Continue, cancel, reports, catalogue snapshots and older-recording preparation. These older full-suite results do not establish the final candidate.

Before readiness: final candidate full checks, owner-control browser checks, assembled uploader/media validation, incompatible-release refusals and the separately coordinated OBS/real-Swarm acceptance case. The exact evidence inventory is maintained with the manager companion in `docs/testing/srs-continuation/validation-inventory.md`.

Known P2 follow-up: an unpublish operation already awaiting its catalogue write can overlap a new live claim and hide the new catalogue entry. Stored footage and completed snapshots remain intact. Owner: admin backend. Reproduction and consequence are recorded in the implementation progress document.
