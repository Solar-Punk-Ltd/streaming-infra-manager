# Stack versions

A stack version identifies the streaming software and deployment contract used by a deployment. It is more than a branch name. The manager records the selected version, its published build and the build observed for each service.

Status, 2026-09-08: this page describes the agreed main-v2 remediation. Version selection for new deployments already exists in the reviewed baseline `d046ebf`. The remediation branches add immutable builds, durable admission, port reservations, build-specific Tested approval and responsive version cards. These task branches were merged into local main-v2 on 2026-09-09 at Levi's request. Combined acceptance remains incomplete. This document does not establish what is deployed on a host.

## Selecting a version

New standalone deployments and groups choose a version in the wizard. The default supplies the initial choice when it is available. If there is no available default, the operator must choose explicitly, even when only one other version is available.

A version list arriving late must leave a usable selector visible. A later default change does not overwrite an explicit choice or discard the draft. If the selected version disappears, the operator chooses again.

Decision D6 from the engine-configuration discussion on 2026-09-07 applies: version selection is for new deployments. Moving an existing deployment or group to another version is outside this agreed set. There is no promised Move version control or move-version API.

Updating a version does not automatically restart its existing deployments. The published build and the build currently running are separate facts.

## Versions page

The Versions page shows the bundled version and registered versions. Each card exposes the version name, ref, commit, build state, default and Tested state, with details that expand for the contract and build information. Actions remain accessible at narrow widths.

- Add registers a ref and starts its build. The build log reports progress and failures.
- Update fetches and builds the selected ref. A failed update keeps a previously usable build available and records the failure. A version without a usable build remains failed.
- Tested records an operator's approval of the displayed artifact. It does not run a test suite or prove live playback.
- Set as default controls the wizard's initial choice. A version must be Tested before it can become the default.
- Remove refuses the bundled version, the default, a building version, any version assigned to a deployment, and any version retained by jobs, observations, operations, execution roots or shipment records. The refusal explains what still retains it.

Adding a version executes that repository's build and deployment code with the manager's capabilities. The operator must trust the selected source.

## Tested and default are separate

For an immutable build, approval names both the displayed commit and build id. The database checks those identities, the layout and Ready status in the same write. A stale page cannot approve a different build of the same commit. Missing immutable identity disables approval.

A legacy row retains commit-bound approval only while it is explicitly legacy and has no build id. It cannot retain that compatibility behavior after publication changes its layout.

When an update changes the approved artifact, approval is cleared. If that version was the default, it stays the default. The wizard shows that it is no longer marked as tested, with the recorded date when an update removed approval. This is decision D07. No historical date is invented. Reapproval and manual withdrawal clear the update-invalidation date.

Repeating publication of the identical approved artifact does not arbitrarily remove approval. A distinct rebuild has a distinct identity and requires its own approval.

## Published builds and retained roots

Under `STACK_VERSIONS_ROOT`, a registered version uses sibling paths:

| Path | Purpose |
| --- | --- |
| `<name>.repo/` | The source clone used to prepare builds |
| `<name>.builds/<build-id>/` | A published application tree |
| `<name>.builds/tmp-<attempt>/` | One attempt's unpublished staging tree |
| `<name>/` | Host-owned configuration and the retained legacy root |

A published build carries `.stack-manifest.json` and a `.complete` marker written last. Its identity includes the commit and build id. A build of the same commit and captured inputs can reuse the existing complete artifact. A distinct rebuild receives an identity such as `<commit>-r1`. Published application payloads are not replaced in place.

The database row is the active reference. Publication updates it atomically and retains the previous build. There is no new build catalogue to manage, following D08.

A deployment captures its build before running scripts. The agreed admission rule validates the selected snapshot under the version-row lock and records a job reference before the build can be pruned. A changed, missing or incomplete selected artifact causes a refusal. It must not silently switch to a newer build or fall back to the bundled checkout. A legitimate legacy bundled row remains distinct from a missing version row.

Pruning protects the current and previous builds, unresolved jobs, observed service references and open operations that still need a build. A failed script or unavailable container observation does not prove that a reference can be released. The legacy root is retained and is not an ancestor of the immutable build directories.

Removing a registered version rechecks its exact identity and every hold while locking its database row. File cleanup starts only after those checks pass. Before deleting payloads, the manager durably writes a sibling `<name>.removal.json` marker. A crash or partial cleanup leaves that marker in place, so a retained database row cannot make a partially deleted build deployable again. Updates, deployment admission and execution registration refuse that marked version.

Retrying removal of the same version can finish the cleanup. The marker remains after successful removal. A later registration of the same name is allowed only when the marker is valid and belongs to an older version ID. Unreadable, malformed, active or future-ID markers cause a refusal. Configured paths must remain inside the verified physical versions directory.

## Host configuration and runtime files

Host-owned inputs include `.env`, `deploy/config.json` and engine `.env` files. The supported configuration-edit path commits them as one revision under a shared advisory lock. Individual files are replaced atomically and the revision manifest, containing their hashes, is written last.

Build or job capture takes the same lock and validates the captured inputs against that revision. An incomplete edit produces a bounded refusal instead of a mixture of old and new inputs. A root without a revision manifest is adopted from its current inputs before later captures use it.

Per-profile runtime files are written atomically for the deployment. They are distinct from the immutable application identity. Credentials are never returned as version metadata or printed as build evidence.

## The bundled version

T04b applies the same publication model to the stack shipped with the manager. A manager deployment supplies a separate incoming tree. The durable shipment command publishes or reuses a complete bundled build and updates the bundled version's database reference. Publication is no longer authorized by ordinary API boot. Boot only refreshes an exact still-legacy metadata snapshot. The fixed production command and upgrade adapters remain unfinished. Published application files already used by running containers must not be overwritten.

The legacy bundled checkout remains available while existing deployments reference it. Updating the manager is not an instruction to restart those deployments or discard their data.

## Contracts, targets and shared image names

The manager reads ports, slot limits, required secret names, engine defaults and supported configuration features from the selected version's contract. Unknown or unreadable allocation information causes a refusal rather than an invented port plan.

D01 limits capacity to the lower of the version's declared maximum and 100 stored deployment records. Stopped records still count. Port ownership is reserved by Docker daemon, transport and port. A stopped deployment keeps its reservations. Target verification and observed bindings determine ownership and release, rather than a script's exit code alone.

Versions that still build shared image tags require the durable admission rules in T05a. An unresolved attempt can block a conflicting deployment until the attempt is resolved. The interface names that attempt. A refusal is not a queued deployment or an automatic retry.

D09 assigns the stack image-name changes and bundled submodule update to Levi. The manager does not manufacture per-version image names through the old proposed Compose override hook. Updating that stack contract does not trigger an automatic restart.

## What is actually running

A version's current commit does not prove which code every service is using. Service observations record build and image identity. A deployment shows one commit only when its relevant services agree, otherwise it identifies the mixed service state. A partial deployment does not advance untouched services to the new build.

`last_full_deploy_commit` records a verified full deployment. It does not replace per-service evidence or establish receiving, publishing or playback readiness.

## Verification and remaining integration

T08's approval and wizard behavior passed unit, browser and type checks. Its eight real PostgreSQL regressions passed at `347c7dd`, including publication between read and write and a competing row lock. T18 carries those semantics into the reviewed responsive cards at `5f835ca`.

T04a's guarded removal and durable markers are locally reviewed through `c55c9d9`. The complete compatibility checkpoint passed 194 SQL and 999 manager tests plus shared/frontend checks and types. The final missing-directory removal correction passed 45 removal SQL and 70 focused checks plus types. Later T01/T11 dependency merges preserve the marker and active-job guards, with 47 removal SQL cases each.

T06's no-op reference cleanup is reviewed at `b65f8d9`. T12's direct ledger phase correction is committed at `2966ab3`. T01's operation holds and successful-completion integration, and T04b's private runtime-copy integration, remain in progress. Those open boundaries must close before the whole retention model is accepted. T06's Linux firewall checks and T05a's matching Engine 29.1.3 / Compose v5.1.4 harness remain separate acceptance items.

No local unit, database or browser result proves the live deployment or playback path. T22 retains that acceptance work and its separately agreed resource and spending limits.
