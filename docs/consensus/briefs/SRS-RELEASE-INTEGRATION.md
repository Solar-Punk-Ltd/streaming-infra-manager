# SRS continuation release integration

Status: active implementation brief under the registered SRS continuation plan.
Date: 2026-09-20.
Owner: OpenAI-hosted Astra.

This is the implementation boundary for R07 and R08. It does not authorize installing a guard on a live host or changing an active deployment. The source changes and an isolated test arrangement are authorized. A live installation needs the concrete release packet and the owner's coordination.

## Manager observation

The manager displays broadcasts separately from deployment state. Continue remains an owner action in the admin app. The uploader supplies authenticated lifecycle observations, including closed records, through `GET /stream/lifecycle`. The proposed response is `lifecycleVersion`, `observedAt` and `streams`. Each stream names its stream ID, admin ID, run number, state, permission, optional reconnect deadline, optional close reason and last observation time.

The manager reads the selected deployment's uploader through its existing container-control boundary. A fixed command can route the uploader's own environment token directly into a loopback request without returning the token. Validate and bound the response before presenting it. Do not copy an environment dump, credential, claim ID or checkpoint path into the manager response. Container selection must retain the project's existing identity checks and remote-target behavior.

Show the sixty-second policy only where the selected immutable stack build advertises this capability. A stale or failed read says status unavailable. A running container does not become Live by inference. A missing admin console link is reported as unconfigured rather than generated from an internal API hostname. Deployment Start, Stop and Restart retain their infrastructure meaning.

## Enrollment and mixed versions

The uploader feature names are `SRS_LIFECYCLE_VERSION=1` and `SRS_UPLOADER_ID`. The existing admin ingest configuration names one SRS endpoint, so enrollment can bind to one configured uploader identity. Do not build a fleet registry for this feature.

A new declaration can enroll only after the configured uploader proves the supported protocol and durable store, and the approved reader/release requirements are satisfied. Capability freshness uses the admin's receipt time. Active legacy declarations finish under their existing behavior. Negotiated lookup distinguishes an explicit legacy result from an old admin response, as recorded in the lifecycle contract.

Adopting a completed legacy recording requires the uploader to validate its entire retained snapshot and format before the admin commits enrollment. Missing history, incompatible opening media and pending failed uploads refuse adoption. A declaration without accepted media can use the separately proven empty outcome. Adoption and continuation must never infer that upload failure means an empty stream.

## Independent release guard

The required guard lives outside candidate checkouts and images. Its installed command is the supported entry point for component deployment and rollback after activation. Calling an old checkout's raw deploy script or manually launching containers is outside that supported path and must not be advertised as protected.

The guard checks the candidate capabilities and persistent lifecycle requirements before stopping a service, changing its files or starting its replacement. It must also cover a manager-image rollback. Installing a new guard only inside the new manager image would not do that.

Implementation must retain these invariants:

- Once managed operation is enabled or enrolled, the durable minimum capability requirement cannot be cleared by selecting an older image, unsetting an environment flag or removing a deployment row.
- Missing or unreadable guard state after installation refuses the transition. It is not treated as an unused host.
- Candidate evidence binds to the exact artifact being started. An unrelated checkout's capability file is not evidence for an old image.
- The wrapper owns the preflight and the subsequent transition. A helper that is never called by the real wrapper does not pass validation.
- The guard can allow a compatible recovery build. It never restores a database over accepted footage.

The implementation worker must propose the minimal concrete artifact layout, candidate binding and bootstrap sequence before coding this guard. The layout must fit the actual admin, stack and manager entry points without installing a general host orchestration service. No live guard is installed by this brief.

## Required checks

The manager checks cover fresh waiting, closed/finalizing, completed replay, stale status, missing capability and credential-free output. The enrollment checks cover idle versus active legacy rows, unsupported or stale capabilities and failed legacy adoption.

The release wrapper regression supplies an enrolled-state fixture and the actual pre-feature candidate. It must refuse before the fake service-stop/start counters move. Repeat for admin, uploader and manager rollback targets. A deliberate removal of the wrapper's preflight call must make the test fail. Pair that with the real pre-feature SQL refusal already exercised against the migrated admin database. The database result alone is not evidence that old ingress was blocked.
