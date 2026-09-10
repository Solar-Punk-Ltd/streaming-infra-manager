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
| T09 money by transaction | `feat/t09-receipt-polling` | Journal, recovery, durable UI, exact target ownership, owned transport factory, bounded receipt polling, the portable intent harness and connected SQL and browser acceptance are included, with the two reviews of that slice acted on. Actual SSH and immutable-image qualification remain. Production qualification catalog is empty. |
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
| T20 CI checks | `feat/t20-ci-completion` | Three required jobs run the build and unit suites, the 518 SQL tests against nine disposable databases and the 144 browser tests against a real Chrome, with no skip counted as a pass. The four container-backed regressions each have a job. The T01 startup-failure file and every job in the manual workflow have not run on a runner. |
| T21 documentation | `c640b10` | Reviewed docs plus a new integrated-status correction are included. Update again as remaining flows close. |
| T22 controlled live acceptance | No task branch | Await D05 inputs, completed prerequisites and separate live authorization. |

## The next work

1. **Close the bundled upgrade and runtime flow, T04b with T01/T11.** Connect the durable shipment command to a fixed production CLI and the ordered upgrade adapters. Ordinary API boot refreshes exact still-legacy metadata only. It must not publish incoming trees, adopt timestamp orphans or recreate missing legacy files. Replace the 12 old boot-publication tests with equivalent coverage through the authorized shipment path as that path is completed. Do not delete or skip the underlying acceptance obligations just to obtain green.
2. **Finish exact execution and recovery completion.** Carry the final deployment owner, job/build reference and existing attempt into the private execution copy. Persist launcher identity before possible creation. An immutable creator receipt proves the creator cannot create more work. A complete fresh daemon observation proves attribution separately. T01 records outcomes only under exact ownership. Release proven operation ancestry only after the required successful watch and complete service coverage. Uncertainty retains holds. T11 must execute the same captured host-input revision it validated.
3. **Close the remaining money flow, T09.** Done on `feat/t09-receipt-polling`, see the dated section below. What remains of T09 is actual SSH and immutable-image qualification. Do not populate production qualification merely because synthetic tests pass.
4. **Finish T21 after those complete flows, and dispatch T20's manual workflow.** T20's own work is done on `feat/t20-ci-completion`, see the dated section below. What remains of it is Levi's: dispatch the docker-backed workflow so its four jobs run once, and turn the required checks on after the `checks` workflow has run. Update docs and acceptance against the final SHA.

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

Merged into `feat/ai-remediation` as 1a9cfd2 on 2026-09-10, with the brief for the next slice, the version settings page, committed beside it (`../consensus/VERSION-SETTINGS-BRIEF.md`). CI is green on the pushed head. Recorded for T20: `frontend/test/versions-layout.test.mjs`, which holds the bundled card's test, runs in neither `pnpm test` nor the checks workflow yet.


## The version settings page, 2026-09-10

Every stack version keeps three kinds of file the operator owns, beside its
checkout on the host: the base `.env`, `deploy/config.json` and one `.env` per
engine. Until now the only way to change one was `stack-config-edit.sh` over
ssh. There is a page for them now, one per version, reached from a **Settings**
button on the version card, and it is what D12 and D13 asked for: a working env
setup, shown and editable, with the secret-like values revealable and settable
by hand.

Three routes carry it, all behind the session gate with the other version
routes. `GET /versions/:id/settings` answers the operator's own files read
against the samples the version's current build ships, so every key comes with
the comment block that sample keeps above it, the value the sample assigns, and
two flags: whether it is secret and whether the manager fills it per deployment.
`PUT` takes the revision the page loaded and commits the whole edit as one, and
`POST /versions/:id/settings/apply` publishes the build that carries it. A
version that has never finished a build answers 409 `settings_not_ready`, and
says that its settings appear after the first build.

What the save must not do is lose a byte. These files carry the host's own
documentation in their comments and are still read and edited over ssh, so an
env file is rewritten from its own current bytes: the lines the save names get
their value replaced in place, keeping the `export` prefix and the spacing up to
the equals sign and any carriage return at the end, and every comment, blank
line and untouched line is copied through. A key the file does not assign is
appended. The whole save runs under one hold of the edit lock, generation check
included, so a page and an ssh session cannot write over each other, and a save
made against a revision that has moved is refused with 409 `settings_changed`
carrying the generation to reload to.

Apply is the part that makes a saved setting reach anything. A deployment reads
its settings from the build it runs, and fetching and running `pnpm -r build`
again for one changed line takes minutes. So apply publishes another build of
the same commit instead: the current build's tree with the settings files
replaced by the committed revision, a fresh build id from `freeBuildId`, the old
manifest's commit and toolchain kept, the revision's generation and hashes
recorded, and a new `treeSharing` field saying whether the unchanged files were
hard linked or copied. Builds stay immutable, so nothing is ever written into an
existing build directory. The unchanged files are hard links, because a
published build is never written to again and the tree is a `node_modules` and a
set of bundles that differ in nothing. A link falls back to a copy on EXDEV,
EPERM or EMLINK, and a symbolic link in the tree is recreated as one rather than
followed. Apply holds the build mutex for its whole run and refuses with the
existing 409 `stack_build_busy` while a build is going, rather than inventing a
second code for the same condition.

The generated secrets rule closes the gap the page would otherwise open. A page
that shows `API_AUTH_TOKEN` and then lets the manager generate a different value
per deployment is a page that lies. Now a required secret whose value the
version's own base or engine env already carries is neither generated nor
written, so the file's own line reaches the containers, which is exactly how
`SRT_PASSPHRASE` and `STREAM_KEY` have always behaved when a deployment set
neither. An empty one is still generated per deployment, and a value already in
`profiles.stack_secrets` still wins over both, because rotating the token a
running container was started with is a decision rather than a side effect. The
rule is one function, `versionSuppliedSecrets`, read by `stackSecretsFor` in the
orchestrator from the same build root `writeProfileEnv` copies the base env
from.

The page masks a secret until **Reveal**, marks a value that still equals the
version's own with `default`, says under a generated key that the manager fills
it per deployment unless a value is set there, and offers the deploy config as a
text area with a **Reset to sample** action. **Save**, **Save and apply** and
**Discard** sit in the footer, a save carries only the keys that moved, and the
two refusals arrive as what to do rather than as a code. The values do come back
in the clear, which is D13: the routes are behind the session gate, a value the
operator cannot see is one they cannot check, and nothing on either side logs
one. The manager logs key names only.

Two mutations were run against the new tests before the code was committed.
Stripping comment lines in the env rewrite turns four cases of
`envSettingsText.test.ts` red. Hard linking the settings files with the rest of
the tree, which would write the new build's values through into the build every
deployment is currently running, turns two cases of `versionSettingsApply.test.ts`
red. The links themselves are checked by inode, both ways: the shared files are
one inode and the settings files, the manifest and the marker are not.

`frontend/test/versions-layout.test.mjs` moved with the card: it counted four
controls per row and there are five now, so it asserts five and the same
everything-fits property at 723, 390 and 1280 pixels. The new browser test is
`frontend/test/version-settings-browser.test.mjs`, which renders the real page
against an offline fixture at 390 pixels.

**Verified, 2026-09-10.** Manager unit 2158 of 2158, sixty two more than the
round before and nothing else moved. The whole `manager/test/database` directory
496 of 496 with nothing skipped, run the nine-database way, four more than
before. Common 307, frontend 78, both manager typechecks and the common and
frontend typechecks clean. The two browser suites were run on their own, as
neither is in `pnpm test`: `versions-layout` 12 of 12 and `version-settings` 13
of 13. Nothing ran against the real host, nothing was pushed, and no `.env` of
the submodule was read.

**The two reviews, 2026-09-10.** Two reviewers went over the slice at `637d758`
with probes and mutations, and a third pass looked at it against the design. The
correctness review found five high and eight medium problems, the security
review two high, five medium and eight low, and the design pass one high gap and
one page nit. Four of those low security findings became fixes of their own, two
were folded into the items beside them, and two were looked at and left alone,
as were five low correctness findings. One question goes to Levi rather than
into code: any signed-in account can read and set these values, which is what
every other route does today, and whether version settings become admin-only is
his to decide. Everything else in `docs/consensus/VERSION-SETTINGS-FIXES.md` is
in.

The gap against D12 was that a version added in the UI never got
`engines/<engine>/.env` at all, so its page had no engine section and half the
secrets the stack keeps could not be set at version level. Seeding now walks the
same sample pairs the completion walks, which means every engine the build tree
ships. The stack's own `ensure_engine_env` copies that same sample when the file
is missing, so a deploy reads what it always did.

What the reviewers actually measured, in the order it was fixed. Every build's
copy of a settings file was world readable, 644 in a 755 directory, and the
apply path carried that 644 forward, as did the deployment's own
`.env.<profile>` holding the generated secrets. All three are 0600 now, and an
existing deployment env is narrowed on the next deploy. Nothing told the
operator that a saved change had reached no build, so the answer carries the
current build's own input generation and the page says `applied` or names the
revision the build is still on. Apply with nothing changed published another
identical build every time, each one clearing the version's approval and walking
the protected build window, so it now answers the build that already carries the
revision with `reused` and publishes nothing. An apply refused with
`stack_build_busy` skipped the page's reload, so the operator's next Save was
refused as somebody else's change when it was their own.

A value the stack's env loader and the manager read differently was written
through: `abc #notacomment` became `abc`, padding was kept by one reader and
dropped by the other, and a quote that did not close swallowed the rest. One
rule in `common` now refuses those, plus the C0 controls and the two Unicode
line separators, and the page shows the same refusal under the field before the
save goes out. `SRS_CONF_FILE` and `OME_CONF_FILE` take only an absolute path,
because the version's compose override mounts whatever they hold, and the regex
that already guarded the per-deployment value moved to `common` so both sides
use one. The refusals name the key and never the value, type errors included.

The rest. A required secret the base env declares blank is the base env's
answer, because the root file wins in the deploy script, and the engine env
decides only a key the base env does not name at all. Apply hard linked the
previous build's `.env.<profile>`, which `writeProfileEnv` truncates in place,
so a deploy on the new build wrote into the build every running deployment
reads. A held edit lock came back as a 500 with the recovery buried in the log
and is now 409 `settings_locked` with the manager's own words and a Try again.
A path of the set holding a link or a directory fell out of the answer silently
and is now named. The GET says `no-store`. One save carries at most sixteen
files and 512 keys, names each file once, and a body over the limit is a 413.
A description took the paragraph documenting a commented out neighbour, so
`ORPHAN_REAP_MS` was explaining `HLS_FRAGMENT`, and a section rule opened two
others. `settings_not_ready` has three reasons instead of one and no null in
any of them, a legacy row offers no settings page at all, a key the version does
not declare can be removed from the page, and a masked field asks the browser
not to save it.

Five mutations were run and reverted. Reading the revision before the lock in
`saveHostConfigSettings` turns the new deterministic interleave in
`versionSettingsSave.test.ts` red and leaves the other four green, which is the
property that file is named for and did not have. Printing `key=value` in
`describeSettingsSave` turns two of its three cases red. Taking the `finally`
out of `applySettings` turns the mutex case red. Unanchoring `SETTINGS_PATH_RE`
and dropping the 64 hex guard in `writeProfileEnv` turn four cases red. Dropping
the `typeError` messages turns the echo case red.

**Verified, 2026-09-10, after the fixes.** Manager unit 2205 of 2205, forty
seven more than the round before. The whole `manager/test/database` directory
497 of 497 with nothing skipped, run the nine-database way, one more than
before. Common 318, frontend 83, both manager typechecks and the common and
frontend typechecks clean. The two browser suites on their own: `versions-layout`
12 of 12 and `version-settings` 23 of 23, ten more than before. Nothing ran
against the real host, nothing was pushed, and no `.env` of the submodule was
read.

**The targeted re-review, 2026-09-10.** A third reviewer went back over the
fixes, confirmed every one of them and had thirty one of thirty three mutations
go red. Six small things came out of it, section R of
`docs/consensus/VERSION-SETTINGS-FIXES.md`, and two of them mattered. A key's
description ended at any comment that looked like an assignment, and a wrapped
sentence looks like one: the block above `BEE_PUBLISHERS` in the stack's own
sample ends on a line reading `# ABR_ENABLED=true, since with no ladder there is
nothing to map onto.`, so the key lost the five lines that say what it is. A
comment ends the run now only when it is a key, an equals sign and a value with
no whitespace, and the fixture carries that real block rather than a shortened
cut of it. The sixteen file bound on a save was pinned by a test sending
seventeen paths no version keeps, so the service refused them as absent and the
bound was never what answered. Both mutations were made, seen red and reverted.
The rest are smaller. Save and Save and apply go off while a field holds a value
the shared rule refuses and the footer names those keys, so a refused value
costs no round trip. The page takes its revision from the reload rather than
from the save the reload was overwriting. Two README sentences wrap where their
neighbours do, a doubled blank line is gone, and the paragraph above now says
eight low security findings rather than four.

**Verified, 2026-09-10, after the third round.** Manager unit 2207 of 2207, two
more than the round before. Common 318, unchanged, and frontend 88, five more.
Both manager typechecks and the common and frontend typechecks clean. The two
browser suites on their own: `versions-layout` 12 of 12 and `version-settings`
24 of 24, one more than before. The database directory was not touched by this
round and was not run. Nothing ran against the real host, nothing was pushed,
and the only `.env` of the submodule read was the `.env.sample` the fixture's
block was copied from.

Merged into `feat/ai-remediation` as 7d9af23 on 2026-09-10, after three rounds: the implementation, the two reviews with their fixes, and the targeted re-review with its fixes. Verified by Fable at 8bf512d before the merge: manager unit 2207 of 2207, the whole database directory 497 of 497 the nine-database way, common 318, frontend 88, the browser suites 12 and 24 on their own, every typecheck clean, the deploy script parses, no em-dash or semicolon in any doc, commit message or added comment, and the submodule pointer unchanged. One accident on the task branch, a scratch directory picked up by a `git add -A`, was replayed out of the history before the merge, and `.scratch/` is ignored from now on. The runbook for the first real deploy and the signed-in live test is `../consensus/FIRST-DEPLOY-SESSION.md`. D14, whether version settings become admin-only, is open for Levi.

## Receipt polling, a portable harness and connected acceptance, 2026-09-10

Until now a transfer that Bee answered with a transaction hash sat in
`submitted` until somebody opened the transfer page and pressed Check. Nobody
watching meant nobody knowing, and the node stayed locked behind that unread
operation. The manager checks for itself now.

An operation that enters `submitted` is given one budget of 30 minutes, written
on the row as `receipt_poll_until` by migration 031 and carried to the browser
as `receiptPollUntil`. While the budget lasts the manager asks the chain for the
receipt about every 20 seconds through the receipt check that already existed,
one batch at a time, scheduling the next tick after a batch ends rather than
from its start so batches cannot overlap. A settled or reverted receipt ends the
polling by changing the state. The budget is never renewed: no operator action
extends it, a restart resumes only the operations whose budget has not passed,
and every operation recorded before this slice keeps an empty deadline and is
never polled. An operation in `submitting` or `unknown` is never polled at all,
so recovery stays the operator's explicit action, and neither is one carrying a
hash conflict.

The two surfaces that show a waiting transfer follow along. The transfer detail
page and the Move BZZ dialog re-read the saved record every 10 seconds while the
deadline is ahead, and stop when the state changes, when the deadline passes or
when the operator leaves. Both only read the saved record. Neither asks the
chain, because the manager is doing that. While polling runs they say so and
name the deadline in the operator's own local time, and once it passes they say
that automatic checks ended without a final receipt and that Check asks the
chain again. The three numbers live once, in `common`, so the manager and the
page cannot drift apart.

Two harness problems are closed with it. The intent browser suite no longer
assumes a Vite listener on port 54291 that nobody starts: every case now owns
its own API and its own Vite on free ports, like every other browser suite. And
the composition is finally exercised whole. `chequebookConnected.test.ts` signs
in over HTTP, goes through the real router behind the real session and same-site
gates into a real PostgreSQL journal, out over the owned Docker transport to a
synthetic Bee, and reads the outcome back. `transfer-connected-browser.test.mjs`
does the same with the browser as the only client, against that manager run as a
forked process. Only the Bee, the chain and the database are synthetic. Both
suites need `T09_TEST_PG_PORT` and skip out loud without it.

**Verified, 2026-09-10.** Manager unit 2218 of 2218, eleven more than before.
Common 321, three more. Frontend unit 95, seven more. The three chequebook
database files with a disposable PostgreSQL on port 55436: connected 8 of 8,
operations 50 of 50, seven more than before, targets 31 of 31, none skipped. The
browser suites one file at a time: intent 3, dialog 10, history 9, recovery 10,
api 2, recovery-api 2, the new polling suite 3 and the new connected suite 3,
all passing, and the connected suite verified to skip with its reason printed
when the database variable is unset. Every workspace typecheck clean,
`git diff --check` clean against the branch base, and no em-dash or semicolon in
any added prose, comment, UI string or commit message. Nothing ran against the
real host, nothing was pushed, and no credential was read.

What remains of T09 after this slice is unchanged and separate: actual SSH and
real image qualification. `PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` is still empty
and a synthetic pass qualifies nothing. T14 still waits on Levi's D04 numbers.

## What the two reviews of the receipt polling slice changed, 2026-09-10

Two reviews read the slice above on detached worktrees at its head, one for
correctness and one for security, with a disposable PostgreSQL and twenty five
mutations between them. Nothing they found was a wrong state machine or a leak.
Two were wrong information on a money screen, several were places where the code
was right and no test would have noticed it stopping being right, and one was a
runaway in the fixtures. All of them are fixed on the same branch.

The dialog no longer flashes. It re-reads the saved record every ten seconds
unattended, and it used to clear the record at the start of each of those reads,
so for the length of a round trip the evidence panel was replaced by the sentence
saying the transaction outcome is unknown. That sentence was untrue at that
moment and it appeared every ten seconds. A re-read of the same request now keeps
what is on screen until the manager answers, and only an answer that really says
the record is missing or incomplete clears it.

A failed read no longer ends the automatic re-reads. One synthetic 503 used to
be enough: the page scheduled nothing from its failure branch and never read
again. A fifteen second timeout, a tunnel blip or a manager restart during a
deploy would have done it. A failed read now costs one cycle.

A conflicted transfer is no longer shown as polled. The manager excludes a row
whose failure reason is `hash_conflict` from its own checks, but the page decided
from the state and the deadline alone, so it promised checks that never happen
and, after the deadline, told the operator to press a Check button that a
conflicted transfer does not offer.

A poll that sees nothing new no longer moves the revision. The manager checks
about every twenty seconds and almost every check sees the same pending answer,
and each one wrote a new revision, about ninety over one budget. The operator's
Check refuses when the revision moved under it, and the recovery actions remount
on it, so a good share of Check presses during polling came back saying the saved
transfer had changed. A check that changes what it observed still advances the
revision. One that does not now records only when it happened.

The poller's log reached nobody. `index.ts` passes no polling options, so the log
was the no-op default and a journal that stopped answering was never recorded
anywhere. It goes through the manager's own `Logger` now, a warning for the
journal and information for the per-tick notes, and the factory hands the poller
two bound calls rather than the whole repository and the whole receipt check.

A shutdown no longer waits out a whole batch. The loop over the due rows never
looked at whether it had been stopped, and twenty rows at the receipt inspector's
fifteen second timeout during an RPC outage is about five minutes, past the
ninety seconds systemd allows before killing the process with its transport
cleanup unverified. The page also says now that the gap between checks grows
while the chain endpoint does not answer, and the feature doc records the worst
case.

Three things were right and untested, and now have tests: that a repeated
response cannot renew a polling budget, that a spent budget stops the dialog's
re-reads as well as the page's, and that the fixture's Vite port comes from its
own probe rather than from the environment. The connected fixtures now refuse to
run unless the API is on loopback and the synthetic Docker is on its own private
socket, they unwind a start that fails partway, and their close runs every step
before reporting the first failure.

The browser fixtures stopped filling the machine. Every fixture built its own
9 MB Vite cache inside a temporary directory that nothing ever removed. Measured
here before the fix: 575 such directories holding 5.0 GB. They share one cache
under the frontend `node_modules` now, which also skips the cold start, and a
fixture with nothing to report removes its own directory. The 477 old directories
whose contents were only that cache and an empty log were removed after checking
each one, freeing 4.0 GB. The 113 that also hold screenshots from earlier runs
were left alone, 958 MB, for Levi to decide on.

**Verified, 2026-09-10, after the fix round.** Manager unit 2222 of 2222, four
more than before. Common 321, unchanged. Frontend unit 98, three more. The three
chequebook database files with a disposable PostgreSQL on port 55436: connected
10 of 10, two more, operations 54 of 54, four more, targets 31 of 31, none
skipped. The browser suites one file at a time: intent 3, dialog 10, api 2,
recovery-api 2, history 9, recovery 10, polling 8, five more, the new fixture
file 3, and connected 3, which was also run without the database variable and
skipped all three out loud. Every workspace typecheck clean after building
common, `git diff --check` clean against the branch base, and no em-dash or
semicolon in any added prose, comment, UI string or commit message. Nothing ran
against the real host, nothing was pushed, and no credential was read.

**Merged, 2026-09-10.** Merged into `feat/ai-remediation` as 8f48fb0 after the
S8 ceiling was anchored to the record instead of the clock (b5a85e8) and a
mini-round of five test-quality items from the targeted re-review (0decec0).
Verified by Fable at 0decec0 on a quiet machine: manager unit 2223 of 2223, the
whole database directory 518 of 518 the nine-database way with no skips, common
321, frontend unit 100, every browser suite green one file at a time, with the
note that `mock-engine-observations.test.mjs` runs only under `node --import
tsx --conditions=development` from the frontend package (T20 records the
command), every typecheck clean, prose clean, no submodule or lockfile movement.
Housekeeping on this laptop: 477 leftover `t09-http-*` fixture directories that
held only a Vite cache were removed (4.0 GB), 113 that also hold screenshots
were kept. Still open after this slice: the production Bee bridge qualification
catalog is empty, real SSH and real image qualification have not run, and T14
waits on the D04 numbers.

## Checks that run what the repository claims, T20, 2026-09-10

Before this slice the workflow ran the build, the three unit suites and the
frontend build. That is what a green check meant. The 33 SQL suites, the twenty
browser suites and the three native transport suites ran nowhere, and the four
container-backed regressions had either no entry point or no job.

Three jobs are required on a pull request now. `checks` gained the native
transport suites, which had been sitting inside the deployment integration
suite: they own temporary Unix sockets and fork synthetic Node children, need
no manager and no Docker socket, and were picked up by an entry point that
refuses to start without `MANAGER_TEST_TARGET`. They live in
`manager/test/native/` and run through `pnpm test:native`.

`database` is new. Every SQL file gates itself on a task port variable and
skips silently without it, so `manager/test/database/run-all.mjs` names the
nine databases in one table, refuses in words when a variable is unset or is
not a port, connects to all nine before anything runs, and treats one skipped
test as a failure. A Postgres 16 service pinned by digest sits beside the
runner and the nine databases are created through the image's own `createdb`.

`browser` is new. The twenty files under `frontend/test` run through one
script, `pnpm test:browser`, under `node --import tsx` because one of them
reaches the manager's TypeScript through specifiers only tsx rewrites. One
file at a time, each owning its Vite and its Chrome. The job proves the Chrome
binary before it starts, so a missing browser is a failed check and never a
passed one, and it carries `t09_test` for the connected transfer suite.

The manual workflow is four jobs instead of one, so a failure shows by name:
`srs-parser`, `ome-gate`, `image-race` and `integration`. T02 had no entry
point and now has one, `manager/test/docker/srs-check-isolation.sh`, which
puts eight files through the manager's own checker at once and asserts that
each refusal names the directive of its own file and none of the other three.
T01 had none either, and now has
`manager/test/integration/engine-startup-failure.test.ts`.

**The file that separates a parse from a start.** T01 needed a config the
manager's check accepts and the engine dies on. It is the version's own
template with `work_dir /no/such/directory;` added. On the pinned SRS image on
2026-09-10, `srs -t` exited 0 and printed that the file is successful, and
`srs` left the container exited with code 255 one second in, printing that it
could not change directory. SRS reads its config first and changes directory
second, and only the second step touches the file system. Both observations
are in the test's header.

**Verified, 2026-09-10.** Manager unit 2261 of 2261, thirty eight more than
before, from the two new unit files. Common 321, frontend unit 100, native 7,
all with no skips. The whole database directory 518 of 518 with nine
disposable databases, no skips, 161 s. Every browser suite through the new
script, 144 of 144, no skips. Every workspace typecheck clean after building
common, both workflow files valid YAML, `git diff --check` clean against the
branch base, and no em-dash or prose semicolon in anything added. Nothing ran
against the real host, nothing was pushed, and no credential was read.

**What did not run and what it costs.** No job in either workflow has run on a
GitHub runner. The T01 startup-failure file needs the whole stack deployed on
one, so its first execution is Levi's dispatch. The SQL suites now run one file
at a time, because two of four parallel runs failed here on tests that read the
clock while another connection holds a lock, which costs about 115 seconds a
run. The OvenMediaEngine gate failed here for a reason that is about this
laptop's network: its publisher spends 93 seconds installing ffmpeg inside a
40 second playlist budget, and with the budget raised the gate passed. The
harness was not changed. The T05a qualification on Docker Engine 29.1.3 with
Compose 5.1.4 is still a separate obligation that neither the runner's versions
nor this laptop's discharge. All of it is in `docs/ci.md`, with an estimate of
about 22 Actions minutes a push.
