# SRS continuation release integration

Status: active implementation brief under the registered SRS continuation plan.
Date: 2026-09-20.
Owner: OpenAI-hosted Astra.

This is the implementation boundary for R07 and R08. It does not authorize installing a guard on a live host or changing an active deployment. The source changes and an isolated test arrangement are authorized. A live installation needs the concrete release packet and the owner's coordination.

## Manager observation

The manager displays broadcasts separately from deployment state. Continue remains an owner action in the admin app. The uploader supplies authenticated lifecycle observations, including closed records, through `GET /stream/lifecycle`. The proposed response is `lifecycleVersion`, `observedAt` and `streams`. Each stream names its stream ID, admin ID, run number, state, permission, optional reconnect deadline, optional close reason and last observation time.

The manager reads the selected deployment's uploader through its existing container-control boundary. A fixed command can route the uploader's own environment token directly into a loopback request without returning the token. Validate and bound the response before presenting it. Do not copy an environment dump, credential, claim ID or checkpoint path into the manager response. Container selection must retain the project's existing identity checks and remote-target behavior.

Show the sixty-second policy only where the selected immutable stack build advertises this capability. A stale or failed read says status unavailable. A running container does not become Live by inference. A missing admin console link is reported as unconfigured rather than generated from an internal API hostname. Deployment Start, Stop and Restart retain their infrastructure meaning.

R07 names are now fixed. The immutable stack tree carries `deploy/capabilities.json` with `{ "schemaVersion": 1, "capabilities": { "srsLifecycle": 1 } }`. The manager captures this as `features.srsLifecycleV1`, defaulting to false for absent, malformed or unsupported evidence. A capable build still needs an enabled version-1 runtime response. The file is added to the stack only with its implementation, and its presence alone never enrolls a stream.

The manager's optional `STREAM_ADMIN_CONSOLE_URL` setting is the public admin console base URL. It is separate from the uploader's internal API address. Validate HTTP or HTTPS, refuse embedded credentials or query parameters, and build the existing admin HashRouter link `#/streams/<encoded admin UUID>`. A missing setting leaves a clear unconfigured-link message. No live setting is changed by this work.

In the uploader response, `observedAt` is the uploader's snapshot-generation time, not the manager's receipt time. Each `lastObservedAt` is the uploader's last validated observation of that run state. The manager records its own receipt time separately. Compute the initial observation age from the two uploader timestamps, then add time elapsed since receipt. This avoids assuming identical host clocks. Active state becomes unavailable after thirty seconds without a fresh validated observation. Closed and completed facts remain terminal facts. A successful read must not relabel an unreconciled journal as a fresh active observation.

The UI ignores replies from a superseded polling request or deployment identity. A slow earlier Waiting response cannot replace a later Closed response. Timeout, failure, unsupported version and stale observation have explicit unavailable results rather than fabricated Live or countdown values.

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

The following layout and bootstrap protocol were reviewed on 2026-09-21. They fit the component entry points without installing a general host orchestration service. No live guard is installed by this brief.

### Installed guard and component receipts

The canonical implementation belongs to the manager repository. Its installed code is outside candidate checkouts and images. The local manager API invokes that installed code through a read-only code mount and a durable host-state mount. Remote uploader transitions use the existing SSH transport to the remote installed wrapper. The host wrapper also gates replacement of the manager image itself. This protects supported deployment paths on a trusted host. It is not a security boundary against an administrator manually replacing containers or code with Docker access.

Each guard installation has its own UUID and a monotonic durable generation. Its protected state retains sticky minimum capabilities, the last receipt and any pending receipt for each local component slot. Installed-but-missing, malformed, unreadable, oversized or symlinked state refuses a transition. State and the installation marker are atomically written and flushed. The state directory and files use owner-only permissions.

The admin requires four slots before new managed enrollment: `manager/default`, `admin/default`, `viewer/default` and `uploader/<configured identity>`. The viewer may be on another host and remains required even when no viewer service is in the uploader's profile. The uploader identity uses the existing bounded grammar `[A-Za-z0-9_.:-]{1,200}`. It is not newly restricted to UUIDs. The installation UUID remains a separate identity.

Each receipt has `schemaVersion: 1`, `installationId`, `generation`, `stateDigest`, `slot`, `minimums: { srsLifecycle: 1 }`, and `artifact`. The artifact binds a SHA-256 candidate tree digest and a service-sorted list of exact Docker image IDs. The fixed private route is `POST /api/internal/release-guard/receipts`. It uses the existing internal bearer token routed directly into the submitting process. Redirects are refused and time, response size and error output are bounded.

The admin first binds an installation UUID to its slot. A later different installation is refused rather than silently replacing that authority. Higher generations cannot lower the minimum capability. An exact same-generation retry is idempotent. A changed body at the same generation conflicts. Separate hosts do not share one generation counter. A timestamp or environment flag is not evidence of an installed guard. Fresh uploader capability observations remain a separate thirty-second check.

The wrapper checks the candidate before building or changing tags. It builds into isolated names, captures immutable image IDs, and supplies its own Compose override that pins those IDs with pulling and rebuilding disabled for the transition. A transition token binds the candidate tree, generated override and images. The sticky minimum and exact pending receipt are flushed before activation. Only after verifying the running images and tree does the wrapper submit that receipt. An ambiguous HTTP result retries the identical durable body. A failed receipt submission leaves compatible running code but blocks new enrollment until reconciled.

Bootstrap installs the guard and initial state, stages capable candidates, runs preflight, builds the immutable artifacts, persists the minimum and pending receipt, transitions, verifies the artifacts and submits each slot's receipt. The admin also checks its current artifact and a fresh matching uploader profile before enrolling the first stream. Compatible updates use the same path. This protocol never restores a database over accepted footage.

## Required checks

The manager checks cover fresh waiting, closed/finalizing, completed replay, stale status, missing capability and credential-free output. The enrollment checks cover idle versus active legacy rows, unsupported or stale capabilities and failed legacy adoption.

The release wrapper regression supplies an enrolled-state fixture and the actual pre-feature candidate. It must refuse before the fake service-stop/start counters move. Repeat for admin, uploader and manager rollback targets. A deliberate removal of the wrapper's preflight call must make the test fail. Pair that with the real pre-feature SQL refusal already exercised against the migrated admin database. The database result alone is not evidence that old ingress was blocked.
