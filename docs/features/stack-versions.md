# Stack versions

A stack version identifies the streaming software and deployment contract used by a deployment. It is more than a branch name. The manager records the selected version, its published build and the build observed for each service.

Status, 2026-09-10. Everything on this page is on the branch `feat/ai-remediation`, at commit `6dc33d1`, which is pull request #40 into `main-v2`. That branch carries the 22 remediation task heads, the bundled version fetched and built on the host from the commit the manager pins, a settings page for each version's own files, the build tree cloning that Apply uses, and the database migrations up to 031. Combined acceptance is not complete. No commit on this branch has been deployed anywhere, so this document does not establish what is running on a host.

## Selecting a version

New standalone deployments and groups choose a version in the wizard. The default supplies the initial choice when it is available. If there is no available default, the operator must choose explicitly, even when only one other version is available.

A version list arriving late must leave a usable selector visible. A later default change does not overwrite an explicit choice or discard the draft. If the selected version disappears, the operator chooses again.

Decision D6 from the engine-configuration discussion on 2026-09-07 applies: version selection is for new deployments. Moving an existing deployment or group to another version is outside this agreed set. There is no promised Move version control or move-version API.

Updating a version does not automatically restart its existing deployments. The published build and the build currently running are separate facts.

## Versions page

The Versions page shows the bundled version and registered versions. Each card exposes the version name, ref, commit, build state, default and Tested state, with details that expand for the contract and build information. Actions remain accessible at narrow widths.

- Add registers a ref and starts its build. The build log reports progress and failures.
- Update fetches and builds the selected ref. On the bundled version it builds the commit the manager pins, and it moves that version's ref onto the pin, so a rebuild after a manager deploy follows the new pin rather than the old one. A failed update keeps a previously usable build available and records the failure. A version without a usable build remains failed.
- Settings opens the page for that version's own files. It is disabled for a version that has not finished a build on this host, and for a version that still deploys from a flat checkout, and the button says which of the two applies.
- Tested records an operator's approval of the displayed artifact. It does not run a test suite or prove live playback.
- Set as default controls the wizard's initial choice. A version must be Tested before it can become the default.
- Remove refuses the bundled version, the default, a building version, any version assigned to a deployment, and any version retained by jobs, observations, operations or execution roots. The refusal explains what still retains it.

Only one build runs at a time on a host. Add, Update and Apply each take the same mutex, and a second one is refused while the first is going, naming the version that holds it.

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

A saved setting reaches a deployment only through a build that captured it, and fetching and building the stack again for one changed line takes minutes. So **Apply** on the settings page publishes another build of the same commit instead: the current build's tree with the settings files replaced by the committed revision, a fresh build id, the old manifest's commit and toolchain kept, and the revision's generation and hashes recorded. The unchanged files are hard linked, because a published build is never written to again, and a link falls back to a copy where the filesystem refuses one. A link in the source tree is recreated as a link rather than followed. The deployment's own env file is copied rather than linked, because a deploy truncates it in place and a link would write the new build's values into the build every running deployment reads. When a build of that commit already carries that revision, Apply answers that build and publishes nothing.

The database row is the active reference. Publication updates it atomically and retains the previous build. There is no new build catalogue to manage, following D08.

A deployment captures its build before running scripts. The agreed admission rule validates the selected snapshot under the version-row lock and records a job reference before the build can be pruned. A changed, missing or incomplete selected artifact causes a refusal. It must not silently switch to a newer build or fall back to the bundled checkout. A legitimate legacy bundled row remains distinct from a missing version row.

Pruning protects the current and previous builds, unresolved jobs, observed service references and open operations that still need a build. A failed script or unavailable container observation does not prove that a reference can be released. The legacy root is retained and is not an ancestor of the immutable build directories.

Removing a registered version rechecks its exact identity and every hold while locking its database row. File cleanup starts only after those checks pass. Before deleting payloads, the manager durably writes a sibling `<name>.removal.json` marker. A crash or partial cleanup leaves that marker in place, so a retained database row cannot make a partially deleted build deployable again. Updates, deployment admission and execution registration refuse that marked version.

Retrying removal of the same version can finish the cleanup. The marker remains after successful removal. A later registration of the same name is allowed only when the marker is valid and belongs to an older version ID. Unreadable, malformed, active or future-ID markers cause a refusal. Configured paths must remain inside the verified physical versions directory.

## Host configuration and runtime files

Every version keeps three kinds of file the operator owns, in `<name>/`: the base `.env`, `deploy/config.json` and one `.env` per engine the version ships a sample for. The supported configuration-edit path, `manager/scripts/stack-config-edit.sh`, commits them as one revision under a shared advisory lock. Individual files are replaced atomically and the revision manifest, containing their hashes, is written last.

A version's first build seeds those files from the samples in the build tree, so an added version starts with the stack's own defaults. Then every env file is completed from the sample of the version being built: the sample's own line for each key the file lacks, appended in the sample's order, committed as one more revision. A key the operator already assigned keeps its bytes, and a value the sample leaves blank stays blank. The bundled version has one extra step before both, described below.

Build or job capture takes the same lock and validates the captured inputs against that revision. An incomplete edit produces a bounded refusal instead of a mixture of old and new inputs. A root without a revision manifest is adopted from its current inputs before later captures use it.

These files carry the stream passphrase, the API token, the webhook token and the Bee passphrase, so a file the manager writes into a config root or into a build is owner only, and a file it replaces keeps the mode an operator gave it. Every path of the set is checked for links before it is read, and what was passed by is logged.

Per-profile runtime files are written atomically for the deployment. They are distinct from the immutable application identity. No credential is returned in the version list or printed as build evidence. The settings page below is the one route that answers these values, and the manager logs key names only.

## Settings for one version

**Settings** on a version card opens `#/versions/<id>/settings`, one section per file, in the order base env, deploy config, engines. Three routes carry it, all behind the session gate with the other version routes.

- `GET /versions/:id/settings` answers the operator's own files read against the samples the version's current build ships. Every key comes with the comment block the sample keeps above it, the value the sample assigns, and two flags: whether the key is secret and whether the manager fills it per deployment. The answer says `no-store`.
- `PUT /versions/:id/settings` takes the revision the page loaded and commits the whole edit as one, under a single hold of the edit lock. A save made against a revision that has moved is refused with 409 `settings_changed` and the generation to reload to. A held lock is 409 `settings_locked`. One save carries at most sixteen files and 512 keys.
- `POST /versions/:id/settings/apply` publishes the build that carries the saved settings, described in the next section.

A version that has not finished a build answers 409 `settings_not_ready`, and says that its settings appear after the first build. A version that still deploys from a flat checkout answers the same code with its own reason: there is no build to make another one from.

A save must not lose a byte, because these files carry the host's own documentation in their comments and are still edited over ssh. An env file is rewritten from its own current bytes: the lines the save names get their value replaced in place, keeping the `export` prefix, the spacing up to the equals sign and any carriage return at the end. Every comment, blank line and untouched line is copied through, and a key the file does not assign is appended. The deploy config is offered as text with a **Reset to sample** action.

The page masks a secret until **Reveal**, marks a value that still equals the version's own with `default`, and says under a generated key that the manager fills it per deployment unless a value is set there. That sentence is the rule the deploy keeps: a required secret whose value the version's base or engine env already carries is neither generated nor written, so the file's own line reaches the containers. An empty one is still generated per deployment, and a value already recorded for a running deployment still wins over both, because rotating the token a running container started with is a decision rather than a side effect.

The values come back in the clear, secrets included. That is decision D13: the routes are behind the session gate, and a value the operator cannot see is one they cannot check. Which accounts should reach this page is decision D14, which is open. Today any signed-in account can, as with every other version route.

## The bundled version

The bundled version is the stack commit the manager pins. It is fetched and built on the host, through the same path an added version takes, which is decision D12 of 2026-09-09: the host checks out the version and builds it there.

A manager deploy no longer carries the stack. It writes `manager/.stack-commit` from the repository itself, `git rev-parse HEAD:manager/swarm-hls-stream`, so the pin is what the submodule records and not what a laptop has checked out. That file is the only thing about the stack a deploy ships.

The API reads that pin at boot. When the bundled row is not already on a complete build of it, boot builds that commit through the same build script, the same one-build-at-a-time mutex and the same log on the Versions page that an added version uses. **Update** on the bundled card means build that pin again. A manager that pins no commit, which is a developer machine rather than a broken deploy, keeps the row on the tree in its checkout and refuses the rebuild in plain words.

Every path that does not start the build writes its reason into the row and moves the row onto the pin, so a deploy waiting for this boot's answer can tell it from an earlier boot's. That covers the mutex refusing while another version builds, a pin file holding something that is not a commit, and a build script that could not be started at all. A version that still has a build stays ready with the reason beside it. A version with nothing to deploy from is failed.

The upgrade command on the host holds one directory under the stack versions root for its whole run. Its phases are checking, stopping, migrating, starting, verifying, and then a bounded wait for the API's own boot to reach a build of the pin. A build that failed or timed out is printed and the command exits non zero, after the guard is released, because the manager is up by then.

On a host deployed the old way, the bundled version's first build takes the stack's `.env`, `deploy/config.json` and engine envs out of the legacy tree, byte for byte, as its config root's first revision. That legacy tree is only ever read, because the engines of existing deployments still mount it, and only the bundled version reads it at all. A config root that already holds settings is left alone.

The legacy bundled checkout remains available while existing deployments reference it. A deployment created while the bundled row was legacy keeps running the legacy tree until its own next deploy moves it. Updating the manager is not an instruction to restart those deployments or discard their data.

## Contracts, targets and shared image names

The manager reads ports, slot limits, required secret names, engine defaults and supported configuration features from the selected version's contract. Unknown or unreadable allocation information causes a refusal rather than an invented port plan.

D01 limits capacity to the lower of the version's declared maximum and 100 stored deployment records. Stopped records still count. Port ownership is reserved by Docker daemon, transport and port. A stopped deployment keeps its reservations. Target verification and observed bindings determine ownership and release, rather than a script's exit code alone.

Versions that still build shared image tags require the durable admission rules in T05a. An unresolved attempt can block a conflicting deployment until the attempt is resolved. The interface names that attempt. A refusal is not a queued deployment or an automatic retry.

D09 assigned the stack image-name changes and the bundled submodule update to Levi, and both are done. The stack's `main-v3` is the stable default and carries the four D09 commits, and the submodule pins its tip and tracks that branch. The stack's `main-v2` is obsolete and is kept only as a second version to test version selection with. The manager does not manufacture per-version image names through the old proposed Compose override hook. Updating that stack contract does not trigger an automatic restart.

## What is actually running

A version's current commit does not prove which code every service is using. Service observations record build and image identity. A deployment shows one commit only when its relevant services agree, otherwise it identifies the mixed service state. A partial deployment does not advance untouched services to the new build.

`last_full_deploy_commit` records a verified full deployment. It does not replace per-service evidence or establish receiving, publishing or playback readiness.

## Verification and remaining integration

Where the branch stands, 2026-09-10, at `6dc33d1`. The last full run recorded on `feat/ai-remediation` was taken at `e857994`, the head verified before the T20 completion merge: the manager unit suite 2317 cases, the whole `manager/test/database` directory 518 cases against nine disposable databases, the browser suites 166 cases against a real headless Chrome, the native transport suites 7, the shared package 321 and the frontend unit suites 100, none skipped, every typecheck clean. Those runs were on a laptop. No job of either GitHub workflow had run on a runner when this page was written.

Nothing on this branch has been deployed. The bundled build on the host, the settings page and Apply have been exercised only against fixtures and disposable trees on a laptop. The first real deploy is a session of its own, waiting for Levi to name a time, and its runbook is `../consensus/FIRST-DEPLOY-SESSION.md`.

Still open for the retention model. Exact execution and recovery completion is the next slice: a deployment still runs out of the immutable build directory rather than a private execution copy of its own, so T01's operation holds and the release of a build a deploy still needs cannot be closed yet. T06's Linux firewall checks and T05a's harness on the matching Docker Engine 29.1.3 and Compose v5.1.4 are separate acceptance items that nothing here discharges.

The task checkpoints behind this page, as they were recorded during the work. T08's approval and wizard behaviour passed unit, browser and type checks, and its eight real PostgreSQL regressions passed at `347c7dd`, including publication between read and write and a competing row lock. T18 carried those semantics into the responsive cards at `5f835ca`. T04a's guarded removal and durable markers were reviewed through `c55c9d9`. T06's no-op reference cleanup was reviewed at `b65f8d9`, and T12's direct ledger phase correction was committed at `2966ab3`. Those are the numbers of the branches as they were merged, not a rerun of the branch as it stands.

No local unit, database or browser result proves the live deployment or playback path. T22 retains that acceptance work and its separately agreed resource and spending limits, and it waits for Levi's D05 numbers.
