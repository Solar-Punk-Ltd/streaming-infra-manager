# main-v2 remediation handover, 2026-09-09

Cross-provider review, OpenAI-hosted Codex, GPT-6 Astra.

## Start here

Levi requested: "okay merge everything to main-v2 locally and create handover". All 22 remediation task heads are now ancestors of local `main-v2`. Their complete histories, original branches and task worktrees are preserved. This consolidates implementation checkpoints. It does not complete the 25-row roadmap or establish deployment readiness.

The reviewed baseline was `d046ebf237f0e93dd5a41d72d6d1df9c0cd8af64`. The local backup branch `codex/main-v2-before-remediation-20260909` preserves that exact baseline. The frozen source heads are in [main-v2-merge-manifest.json](main-v2-merge-manifest.json). Thirteen explicit merge commits brought in the 22 heads because several task branches already contained dependencies.

This handover supersedes earlier local notes saying main-v2 is unchanged, local merges are forbidden, T01's service callers are still unwired, or T09 has no owned factory. The full planning debate and historical evidence remain in `.scratch/main-v2-review-consensus/`. Its `PRD.md` comments were not edited. That scratch directory remains untracked. This handover and its manifest are tracked.

No push, GitHub write, repository setting, image pull, installation, real engine build, deployment, SSH or funded-node operation was performed for this consolidation. An initial pnpm typecheck tried its automatic dependency reconciliation and stopped before removing modules. No install completed. Subsequent checks used existing local executables directly. Its small generated store is preserved under the local merge evidence directory.

## Authorization for continuation

Levi explicitly overrode the reviewer-only restriction for the agreed local work. Local worktrees, source and test edits, commits and disposable tests are authorized. He also authorized subagents and this local main-v2 consolidation. Do not ask for the same permission again.

Continue new work on a task branch from the merged main-v2, with tests first, one logical fix per commit and independent review in another worktree. PR bodies remain local drafts under `.scratch/main-v2-review-consensus/prs/`. Preserve existing source branches and other workers' resources. Do not resume an old task checkout and accidentally omit the integration fixes.

Pushes, GitHub writes, repository settings, host access, real engine builds and pulls, deployments and live money operations still require separate explicit authorization. Do not access Claude memory, estate, beeClients, secrets or the shared development services on ports 5186 and 3035.

## Roadmap, all 25 rows

The heads below are the task checkpoints included in this merge, not a claim that every acceptance criterion passed.

| Row | Included head | State and remaining acceptance |
| --- | --- | --- |
| T01a restart count | `115b194` | Correct top-level Docker restart count and regression are included. |
| T01 configuration operations | `82e2d08` | Atomic claims, retained-build recovery and apply/reset/recovery service callers are connected. Immutable execution, exact successful finalization and operation-hold release remain. |
| T02 isolated SRS validation | `1ab3e72` | Concurrent checks have private files. The real concurrent parser harness still needs CI execution. |
| T03 OME validation | `be10c3b` | XML parser, protected paths and harness are included. Recorded arm64 evidence is historical. Stack pin, amd64 and CI qualification remain. |
| T04a immutable builds | `c55c9d9` | Immutable publication, retained references, guarded removal and durable removal markers are included. Complete retention acceptance depends on T01/T04b execution. |
| T04b bundled publication/runtime | `c61ac5e` | Durable publication command, registered candidates, receipt replay and legacy metadata CAS exist. Production CLI/upgrade adapters, private execution copies, complete observation and retirement remain. Twelve obsolete boot-publication tests remain red. |
| T05a creation guard | `3220114` | Durable admission/recovery guard and release UI are included. Matching Engine 29.1.3 and Compose v5.1.4 harness remains unrun. |
| T05b stack image changes | No task branch here | Levi owns the external stack image-name/cleanup commits and bundled submodule update under D09. |
| T06 port reservations | `b65f8d9` | Reservation and target admission are included. Combined execution verification and Linux firewall qualification remain. |
| T07 proposed deployment row | `24b85bf` | Validation, admission and write use the proposed row. Unknown critical prerequisites refuse. |
| T08 build approval | `347c7dd` | Approval names the displayed commit/build and the wizard requires an explicit valid choice. Integrated with T18 and both publication writers. |
| T09 money by transaction | `b1b1aec` | Journal, recovery, durable UI, exact target ownership and owned transport factory are included. Finite receipt polling, portable intent harness, connected SQL/browser acceptance and actual transport/image qualification remain. Production qualification catalog is empty. |
| T10 authenticated integration client | `284790c` | Confirmed-instance cleanup and atomic profile/group removal are included. Real deployment integration has not run. |
| T11 effective engine settings | `ef269a8` | Observations, draft preservation, exact-job save and captured-build validation are included. Mutable host-input execution integration remains. |
| T12 readiness and diagnostics | `2966ab3` | Readiness, diagnostics and lifecycle phase behavior are included. Complete lifecycle acceptance remains with execution integration. |
| T13 SRT default | `0a0aebc` | Per-deployment default and review copy are included. |
| T14 guided stamp purchase | No task branch | Await D04 capacity/lifetime presets and spending ceiling, then implement after T09. |
| T15 pool prerequisites | `8d326aa` | Pool creation preserves uploader drafts and handles stale membership observations. |
| T16 validation feedback | `1f14207` | Field feedback, accessible labels and focus behavior are included. |
| T17 endpoint actions | `7354bfe` | Protocol-aware link/copy actions coexist with container diagnostics. |
| T18 narrow layouts | `5f835ca` | Responsive version cards preserve exact-build approval and attempt-release controls. |
| T19 notes editing | `6b3c50c` | Separate notes updates and revision conflicts coexist with full deployment edits. |
| T20 CI checks | `1eb7cdd` | Partial workflow is included. SQL, browser and real parser/engine entrypoints and required-check execution are unfinished. |
| T21 documentation | `c640b10` | Reviewed docs plus a new integrated-status correction are included. Update again as remaining flows close. |
| T22 controlled live acceptance | No task branch | Await D05 inputs, completed prerequisites and separate live authorization. |

## The next work

1. **Close the bundled upgrade and runtime flow, T04b with T01/T11.** Connect the durable shipment command to a fixed production CLI and the ordered upgrade adapters. Ordinary API boot refreshes exact still-legacy metadata only. It must not publish incoming trees, adopt timestamp orphans or recreate missing legacy files. Replace the 12 old boot-publication tests with equivalent coverage through the authorized shipment path as that path is completed. Do not delete or skip the underlying acceptance obligations just to obtain green.
2. **Finish exact execution and recovery completion.** Carry the final deployment owner, job/build reference and existing attempt into the private execution copy. Persist launcher identity before possible creation. An immutable creator receipt proves the creator cannot create more work. A complete fresh daemon observation proves attribution separately. T01 records outcomes only under exact ownership. Release proven operation ancestry only after the required successful watch and complete service coverage. Uncertainty retains holds. T11 must execute the same captured host-input revision it validated.
3. **Close the remaining money flow, T09.** Add bounded receipt-only polling without resubmission, automatic scans of unknown submissions or indefinitely renewed budgets. Make the intent-browser harness own its server instead of assuming port 54291. Exercise the authenticated UI/API against synthetic SQL and owned transport. Actual SSH and immutable-image qualification remain separate. Do not populate production qualification merely because synthetic tests pass.
4. **Finish T20/T21 after those complete flows.** Run all required SQL with explicit task database configuration and fail missing setup instead of counting skips. Add the frontend mock/browser suites. Separate the three native transport integration files from real deployment integration. Wire the T01 startup-failure, T02 concurrent parser, T03 OME and T05a matching-version harnesses. Update docs and acceptance against the final SHA.

Two T04b adapter constraints remain explicit. First-use initialization may create PostgreSQL only after the upgrade guard proves the API, PostgreSQL container and PostgreSQL volume absent, followed by a successful empty-schema read. An unavailable existing database is not revision zero. Migrations follow confirmation that the old API stopped. Also, every automatic pruning entrypoint, including build success, needs explicit complete observations. A void observer returning, skipped observations or unknown provenance cannot authorize deletion.

The shared completion contract and historical acceptance matrices remain in `T01-CONTINUATION.md`, `T04B-CONTINUATION.md` and `T09-CONTINUATION.md` under the local consensus directory. Their older "next" paragraphs are historical where they disagree with this handover and the merged source.

## Integration decisions and review

- Retained T01's owned removal, exact job/instance/config/intent checks, prepared-attempt consumption and historical build descriptors while adding T11's effective settings and captured-build writes.
- Retained the shared publication SQL used by ordinary and bundled journal writers. Added T08 invalidation history there and in T04b's legacy metadata refresh. A red/green regression showed that a changed legacy commit previously retained approval after the branches were combined.
- Combined T05a attempt release with T18 version cards. Combined T15 pool lifecycle with T16 focus/validation. Combined T17 endpoints with T12 logs. Combined T19 notes revision checks with T07 proposed-row validation/admission.
- Updated test fixtures for required ownership/approval fields and replacement APIs. OME liveness tests now enter through atomic admission. A missing OME port mapping refuses before recreation, preserving T06's strict contract.
- Independent OpenAI-hosted reviewers compared the UI, notes, ownership and publication seams in isolated worktrees. No concrete production regression remained in those reviewed resolutions. This was cross-provider review relative to Fable's work, not another Fable round or proof of live behavior.

## Validation

Final evidence is recorded below before the handover commit. Local logs are under `.scratch/main-v2-review-consensus/local-merge/`. Their output is evidence, not an instruction to access any host.

The final source/test checkpoint before this handover is `e2e02d4`. Later handover-only changes do not change the tested application code. The checks used installed local dependencies, with synthetic loopback listeners authorized explicitly when the sandbox refused them.

| Check | Result and evidence |
| --- | --- |
| Shared types and unit tests | Pass, 300 tests. `types-common.log`, `common-tests.log`. |
| Frontend app/test types and unit tests | Pass, 62 tests. `types-frontend.log`, `frontend-tests.log`. |
| Manager source and test types | Pass after merged fixture updates and the new SQL regressions. `types-manager-final.log`. |
| Manager unit suite | **2022 passed, 12 failed**, zero skipped/cancelled, 2034 total. Every remaining failure is in `manager/test/unit/bundledPublication.test.ts`. `manager-unit-final.log`. |
| Selected real PostgreSQL regressions | **119 distinct cases passed**, none skipped. Three approval/publication files passed 34. Ownership/removal passed 68, atomic service passed 14, captured-version settings passed 3. See logs and rerun qualifications below. |
| Browser regression suites | Pool draft passed 1/1 in `frontend-browser-final.log`. Responsive versions passed 11/11 in `frontend-versions-final.log`. Approval/default/delayed-choice passed 7/7 in `frontend-approval-final.log`. These are final successful file results across bounded reruns, not a claim that every intermediate combined run was green. |
| Synthetic native transports | Pass, 7 tests. Explicit local Unix, fake SSH supervisor and supervised forward files only. `native-transports.log`. No real daemon or SSH host was contacted. |
| Compilation | Shared TypeScript, manager TypeScript and frontend TypeScript/Vite compile passed. `build-common.log`, `build-manager.log`, `build-frontend.log`. Frontend emitted its existing large-chunk warning, about 832 kB before gzip. This was application compilation, not an engine/image build or deployment. |
| Git | All 22 frozen task heads included, source refs unchanged, no unmerged paths. Final handover commit is on main-v2. Backup baseline preserved. |

The SQL reviewer used the exact merged production code plus fixture correction `3436c20` in an isolated checkout. The new two-test commit was then cherry-picked as `80604d2`. `approval-publication-sql.log` passed 34/34. `ownership-removal-sql.log` passed 68 cases, but two other files failed import because that review checkout lacked already-pinned saxes. After copying existing local packages, `service-settings-sql-rerun.log` passed 14 cases and one other file stopped for missing synthetic DATABASE_URL. `settings-capture-sql-rerun.log` then passed its unchanged 3 cases. Preserve those setup failures and successful reruns. No database assertion failure remains in the selected set.

The original sandboxed manager run failed because local test listeners were refused. Its log is retained as `manager-unit-initial.log` and is not product evidence. The first authorized aggregate run then exposed four OME fixture failures in addition to the 12 known bundled tests. Those four are fixed and pass. The browser logs retain the missing mock attempts endpoint, explicit late-version selection and render-timing failures preceding their corrections.

The T03 draft already records all four provenance checks for the introduced `saxes` 6.0.0 and `xmlchars` 2.2.0 versions. It records 2021-11-07 and 2019-09-06 publish dates, verified registry signatures, installed-tree signature verification and no listed advisories including malware. Neither package has a provenance attestation. This is carried historical evidence from `.scratch/main-v2-review-consensus/prs/t03-ome-xml.md`, not a fresh registry query during this merge. No dependency version was changed by the conflict resolutions.

No full real deployment suite, Linux firewall qualification, actual SRS/OME/shared-image container harness, production SSH/image qualification, funded transfer, upload, playback or T22 run occurred. CI is still a partial draft. The merged branch is therefore **not release-ready**.

## Open inputs and funded assets

D01 through D10 are already decided. D04 still needs the guided stamp preset capacities/lifetimes and spending ceiling. D05 still needs the live spend cap, duration, publishing content and disposition of the node's funds. These are inputs to decided policies, not a reopened design vote.

The funded `review-20260907` deployment was not touched. The historical 0.5 BZZ chequebook fill's submission remains unverified. There is no transaction evidence here establishing that it was unsent, settled or safe to retry. Preserve the node and its assets. Do not run the R04/shared-image script on the host. The matching-version T05a harness is a later isolated run on Engine 29.1.3 and Compose v5.1.4.

## Preserved local state

- Original task worktrees and all 22 frozen source refs remain. The merge manifest records exact heads. Historical/rebased feature branches outside the remediation set were not indiscriminately merged or deleted.
- Synthetic PostgreSQL fixture `285c10f9f8ae41c877fb54fe88f53e2ec3b8bb9ae3808872c02cee74bbadbe9a`, loopback 62527, belongs to `implement_t08_completion`. It holds synthetic task databases and previously retained interrupted schemas.
- Synthetic fixture `6b755f793656af867ad33f9564fabc1a5d06f2d324a88cad91fe58f748fd656b`, loopback 61175, belongs to `implement_t12_readiness`. Preserve the previously documented incomplete-run schema. Only the owners clean these fixtures.
- Integration SQL review tree: `/private/tmp/integration-approval-sql-codex`. Documentation review tree: `/private/tmp/t21-handover-codex`. Read-only UI review: `/private/tmp/t04b-merge-review-4372848`. These are separate from the original task trees.

On resume, read this file first, inspect main-v2's actual HEAD and working tree, then choose one remaining complete flow. Verify any retained resource by its exact recorded identity before use. Never infer cleanup authority from a name prefix or a stopped test runner.

## Where the record lives, 2026-09-09

The planning and acceptance files under `.scratch/main-v2-review-consensus/` are now also tracked, unchanged, under `docs/consensus/`, with an index in its README. The scratch directory stays as the home of the originals, the logs and the browser evidence.

## After the merge: the publication command slice, 2026-09-09

Fable (Anthropic), with Opus agents implementing and reviewing. Levi decided to keep the durable publication design and build the command, opened PR #40 from `feat/ai-remediation` into `main-v2`, and authorised pushing every finished slice to that branch.

What landed: `bundled:seal` on the laptop, `manager:upgrade` from the new image on the host, the deploy script wired to both, the twelve red boot-publication tests replaced by tests through the new path, and a sweep that removes every shipped package and claimed copy a finished publication made unreadable, so the host does not keep a copy of every secret every deploy shipped. Two reviews of the slice and one targeted review of the fixes found and closed, among others, the first-use probe counting the upgrade's own one-off container, `docker compose run` swallowing the rest of the remote script, the first-use rule firing again after the migration, the started api never being checked against the image the upgrade built, and the repository's `.dockerignore` letting `manager/.env` into the image build context. The briefs are `../consensus/T04B-COMMAND-BRIEF.md` and `../consensus/T04B-COMMAND-FIXES.md`.

Verified at the merge: manager 2146 unit tests green, common 300, frontend 62, the three typechecks clean, the database test directory 159 green against a disposable local Postgres, and the manager image build context clean of the env file. Nothing has run against the real host. The first deploy with this flow needs Levi's word.

Still open from the list above, in this order: exact execution and recovery completion (T01 with T04b private execution copies, so deploys stop writing into the immutable build), T09 receipt polling and its harness, T20 and T21, then T14 and T22 on Levi's numbers. The D09 stack commits reached the stack's main-v3 the same evening, see the next section.

## The bundled stack is main-v3, 2026-09-09

Levi ruled that the stack's `main-v3` is the stable default and that `main-v2` is obsolete, kept only as a second version to test version selection with. He fast-forwarded the stack's `main-v3` to the four D09 commits (head `9f1255b`, the two built services no longer name their images, a whole-project clean removes the images it built), so no branch of the stack repository is referenced anywhere: the bundled submodule pins the tip of `main-v3`.

What landed on `feat/ai-remediation`: the pin moves from the tip of the stack's `main-v2` (`ee99c36`) to `9f1255b`, the submodule's tracked branch becomes `main-v3`, and the manager README, the deploy README and the engine-control feature page say which version is bundled and what its contract decides (slot ceiling 99, `API_AUTH_TOKEN` and `SRS_WEBHOOK_TOKEN` generated per deployment, the SRS API port published, engines on a config file of their own, chequebook floor 0.5 BZZ). No code changed: the manager reads all of that from the stack's contract.

Verified with the new pin: manager 2146 unit tests green and typecheck clean, the real tree's contract read with no warning and `sharedImageTags` false, the stack installed and built on the laptop with the same two commands `deploy/deploy.sh` runs. A trial seal of the real tree then refused the laptop's stack `.env`, which still follows the `main-v2` sample and lacks twenty keys the `main-v3` sample declares (only the key names were seen). That is the check working as designed, and it means the first deploy after this bump needs those keys added to `manager/swarm-hls-stream/.env` first. The deploy README now says so. The trial's generation-one revision file was removed again, so the laptop checkout is back to never having had one and the deploy's `--adopt-inputs` takes the files as they are.

Nothing has run against the real host. Next, unchanged: exact execution and recovery completion, then T09, T20, T21, T14 and T22.

## The bundled stack is built on the host, 2026-09-09

Levi's D12: "We run the infra manager on the server. The host should be able to
checkout and pull the version or tag or branch whatever and build it there.
Immediately it shows the settings that's needed for that version but filled with
the working defaults." The bundled version stops arriving with the deploy. The
brief is `../consensus/BUNDLED-ON-HOST-BRIEF.md`, the work is on
`feat/bundled-on-host` off `feat/ai-remediation`.

**What changed.** `deploy/deploy.sh` writes `manager/.stack-commit` from the
repository itself, `git rev-parse HEAD:manager/swarm-hls-stream`, so the pin is
what the submodule records and not what a laptop has checked out. That file is
now the only thing about the stack a deploy carries. At boot the api reads the
pin and, when the bundled row is not already on a complete build of it, builds
that commit through the same path an added version takes: the same build script,
the same one-build-at-a-time mutex, the same log on the Versions page. Update on
the bundled version means rebuild that pin, and refuses with a plain message on a
machine that pins none. The build script learned to fetch a forty character
commit, which `git clone --branch` refuses. The upgrade command lost the
shipment: its phases are checking, stopping, migrating, starting, verifying and
then a bounded wait, `--bundled-timeout`, for the api's own boot to reach a build
of the pin. A build that failed or timed out is printed and exits non zero, after
the guard is released, because the manager is up by then.

**Settings.** The first build on a host deployed the old way takes the bundled
stack's `.env`, `deploy/config.json` and engine envs out of the legacy tree at
`SHLS_ROOT`, byte for byte, as the config root's first revision. The legacy tree
is only ever read, because running engines still mount it, and only the bundled
version reads it at all. Then every env file is completed from the sample of the
version being built: the sample's own line for each key the file lacks, in the
sample's order, appended and committed as one more revision, which the build then
captures. A file that does not parse, and a base env that is still short after
completion, are refused with today's messages. That is the settings model the
version settings page of D13 will read: one set per version on the host,
committed as revisions in `.config-revision.json` under the same lock the editing
script takes.

**What went.** `bundled:seal`, the package format, the shipment journal
(migration 030 drops `bundled_shipments` and its trigger, keeping
`publication_revision` and its trigger), the publication command, the
materializer, the package claim and sweep, the toolchain flag, and the strict
path mode of the host config capture that only the seal used. Their tests went
with them. The deploy script lost the stack build, the seal, the package rsync,
the identity checks and the remote home probe those guarded, because with the
package gone the only values it still interpolates into a remote command line are
a local `git rev-parse` and a local `shasum`.

**The T04b guarantee still holds and is still tested.** A deployment created
while the bundled row was legacy keeps running the legacy tree until its own next
deploy moves it: `manager/test/unit/deployBuildDescriptor.test.ts`, "runs the
legacy tree until the bundled version is published, and its build after, each by
its own deploy". `bundledBootRecovery.test.ts` still asserts that boot's metadata
refresh adopts nothing and writes nothing into the legacy tree, and
`bundledPublication.test.ts` was reworked around the new boot behaviour rather
than deleted.

**Verified.** Manager unit 2063 of 2063, manager database 98 of 98 against a
disposable local Postgres, common 300, frontend 68, both manager typechecks and
the common and frontend typechecks clean, `bash -n deploy/deploy.sh` clean.
Earlier runs of the same suites, at load average 34 to 45 on this machine, failed
a handful of timing-sensitive tests that pass alone, including
`ownedChequebookPreparation.test.ts` and the pre-existing
`legacyMetadataRefresh.test.ts` and `acquireDockerBeeStream.test.ts`, which
nothing in this slice touches. `feat/ai-remediation` failed four of the same
tests under that load, so the sensitivity is the machine's and not this branch's.
Nothing ran against the real host, nothing was pushed, and no `.env` of the
submodule was read.

**Two things the brief asked for that are not here.** The build script's commit
path is covered by a real run against a repository on this disk, put behind the
stack's own https url with git's `insteadOf` in a home directory of the test's
making, so neither the url check nor anything else in the script was relaxed for
it. `readManagerPublication.ts` was kept and simplified rather than deleted: the
brief lists it among the removed modules but also says `readPublication` keeps
the first-use rule and the schema state, and something has to read the schema.
Its database test was rewritten rather than removed, and it is where the
migration-030 assertions live.

**After the reviews, 2026-09-10.** A security review and a correctness review
ran in parallel over the slice and found fourteen things, all now fixed on
`feat/bundled-on-host`, one test-first commit pair each. The two that mattered
were the same leftover from both sides: `removeGuarded` still asked
`bundled_shipments` whether a version was held, and migration 030 drops that
table, so the first version removal after an upgrade would have failed on the
host and eleven database tests failed on the branch. The other one that could
have reached the host is the guard: the twenty minute bundled wait did not catch
its own read errors, so one failed query after the api was verified left
`.manager-upgrade` behind and refused every later deploy. It now releases before
it rethrows.

Three findings were about the settings files, which hold the stream passphrase,
the api token, the webhook token and the bee passphrase. They were being written
at 0644 under a versions root anyone on the host can enter, because the atomic
replacement wrote its temporary file with no mode. A file a commit creates is now
owner only and a file it replaces keeps the mode an operator gave it. The
completion and the legacy carry over both read a file and then took the lock only
for the write, so an edit made in between was overwritten: `withHostConfigLock`
now takes the lock once and hands the body a commit. And the set of settings
files was built with calls that follow symbolic links, so a link planted in the
legacy tree would have had its target read in the api container and committed as
generation one. Every path of the set is now lstat checked, the `deploy` and
`engines` directories included, and what was passed by is logged.

The build script fetched from whatever `remote.origin.url` the clone on disk
carried, so the https only check held for the first build alone. It repoints
origin at the checked url before every fetch. The deploy refuses a
`BUNDLED_TIMEOUT` that is not whole seconds and an ssh target starting with a
dash, keeps the exit status of the upgrade so the receipt reaches the deployer
before the failure, and `--bundled-timeout` is now optional with the twenty
minute default the operations already carried. `deploysBuildOf` moved next to
`deployRootProblem` so boot and the upgrade decide ready by the same rule, and
the wait counts a `lastError` as its own only when the row has moved since it
started the api, which is what tells this build's failure from one an earlier
boot left standing. That baseline is read in `startProject`, which is the last
moment before the new api can run its own boot.

Two gaps in the tests were closed by mutation rather than by a code change.
"Existing lines byte for byte untouched" had no fixture with a comment, a blank
line, trailing spaces or a CRLF line, so stripping every comment and trimming the
leading blank both passed. Both now go red. The bundled card's enabled Update
button was asserted nowhere, and putting the old disable back passed every test.
`frontend/test/versions-layout.test.mjs`, which renders the real page in headless
Chrome, now asserts the button is enabled and the commit is on the card. That
file is not part of `pnpm test`, which reads `src/**/*.test.ts` only, so it was
run on its own: 12 of 12. The live build script test also set only `HOME`, which
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_COUNT` outrank, so a developer with either
set would have sent that fetch to github.com. It answers all of them now.

**Verified, 2026-09-10.** Manager unit 2081 of 2081. The whole
`manager/test/database` directory 492 of 492 with nothing skipped, against a
disposable Postgres holding the nine databases the files name, every
`*_TEST_PG_PORT` set. That is five fewer than the base commit, which is exactly
the four shipment cases and the one dropped table this round removed. Common 300,
frontend 68, both manager typechecks and the common and frontend typechecks
clean, `bash -n deploy/deploy.sh` clean, and the remote heredoc body parses as
bash on its own. Nothing ran against the real host, nothing was pushed, and no
`.env` of the submodule was read.

**Third round, 2026-09-10.** A targeted re-review of those fixes found six more,
all now in, one test-first commit each. Two were the same two shapes again, in
places the first round missed. `manager/scripts/stack-config-edit.sh`, the
supported way to edit a version's settings by hand, created its temporary file
at whatever the umask allowed, so one `set` widened a 0600 `.env` back to 0644
and undid the mode fix through the one door an operator is told to use. It now
creates that file owner only and gives it the mode the target already has, and
the revision manifest goes the same way. `seedHostConfig` asked whether a file
was there outside the lock and committed under a fresh one, so a file an
operator created while a build ran was written over by the sample. It holds the
lock across both now, and `adoptHostConfig` commits through the caller's hold
rather than taking its own.

A legacy tree whose `deploy` or `engines` is a symbolic link was reported as
holding nothing at all, so nothing was carried and no log said why. Those two
paths are now named the same way a linked file is. The modes were asserted only
where a file already existed, so the rule that a carried file lands owner only
and a completed file keeps the mode it had was not held by anything. It is now,
proven by a mutation that drops the mode handling and turns three suites red.

The last one is the twenty minute wait a deploy does for the bundled build. It
told this boot's answer from an earlier one's by the row having changed, and a
boot that never started the build left the row byte identical, so the deploy sat
out its whole bound and then printed an error from an earlier boot. Every path
in `ensureBundledBuild` that does not start the build now writes the reason into
the row and moves it onto the pin: the mutex refusing while another version
builds, a `.stack-commit` that holds something that is not a commit, and a build
whose script could not be started at all. A version that still has a build stays
ready with the reason beside it, a version with nothing to deploy from is
failed, and a machine with no pin file, which is a laptop rather than a broken
deploy, is still left alone. `docs/features/stack-versions.md` lost the last
mention of shipment records among the removal holds.

**Verified, 2026-09-10.** Manager unit 2096 of 2096, fifteen more than the round
before and nothing else moved. The whole `manager/test/database` directory 492 of
492 with nothing skipped, run the nine-database way. Common 300, frontend 68,
both manager typechecks, the frontend typecheck and `bash -n deploy/deploy.sh`
clean. Nothing ran against the real host, nothing was pushed, and no `.env` of
the submodule was read.
