# T20 completion brief: checks that run what the repository claims

Written by Fable on 2026-09-10 for the Opus implementation session. Baseline: `feat/ai-remediation` at 49310f7, the T09 completion merge (8f48fb0) plus its handover line. Task branch: `feat/t20-ci-completion`. The PR is #40 into `main-v2`.

## What T20 is, what exists, what is missing

T20 is the agreed merge gate: a workflow on every pull request that proves the code compiles and its guarantees hold, and a separate, documented Docker-backed workflow for the container-backed regressions. Decision D06: the checks are required on `main-v2`, Levi keeps a bypass, agents never push to `main-v2`. Read `docs/consensus/issues/t20-ci-and-merge-gate.md` and `docs/ci.md`.

What exists at the baseline: `.github/workflows/checks.yml` (install, common build, typechecks, the three unit suites, the frontend build, green on the pushed head) and `.github/workflows/docker-checks.yml` (manual, Postgres beside the runner, the manager started with the bundled stack, the signed-in integration suite, never run). Both pin their three actions by commit.

What is missing, named by `docs/handover/main-v2-remediation.md` under "The next work", item 4:

1. **The SQL suites do not run in CI.** `manager/test/database/` holds 33 files, each gated on a task variable such as `T09_TEST_PG_PORT`, and each skips silently when its variable is unset. Nothing on a runner sets them. A green check today proves nothing about the database ownership, admission and recovery rules those files pin.
2. **The browser suites do not run in CI.** `frontend/test/*.test.mjs` holds fourteen Chrome-driven suites and five Node-only suites (four mock suites and `transfer-fixture.test.mjs`), plus `test/support/chrome-protocol.test.mjs`, all outside `pnpm test`. Recorded in the roadmap since the T04b slice: `versions-layout.test.mjs` and `version-settings-browser.test.mjs` run nowhere on a pull request. The T09 completion slice added `transfer-polling-browser.test.mjs` and `transfer-connected-browser.test.mjs`, the latter needing Postgres.
3. **Three native transport files sit inside the deployment integration suite.** `manager/test/integration/localDockerUnix.test.ts`, `nativeSupervisedForward.test.ts` and `sshForwardSupervisor.test.ts` need no manager, no Docker socket and no target declaration: they own temporary Unix sockets and fork synthetic Node children. They are picked up by `test:integration`, which refuses to start without `MANAGER_TEST_TARGET`, so they run nowhere.
4. **The Docker-backed workflow lacks the four container-backed regressions.** T03's OME admission gate (`manager/test/docker/ome-admission-gate.sh`) and T05a's shared image race (`manager/test/docker/shared-image-race.sh`) exist as scripts and are not wired. T02's real SRS parser check on distinct directives and T01's container-backed startup failure have no entrypoint at all.

Out of scope: the branch protection setting (Levi's, after the workflow has run), a real host, funds, the qualification of the exact Engine 29.1.3 and Compose 5.1.4 pair for T05a (the harness prints what the runner has, the qualification on the exact pair stays a separate, named obligation), new npm dependencies.

## Runner facts, read on 2026-09-10

From the `actions/runner-images` Ubuntu 24.04 README (`images/ubuntu/Ubuntu2404-Readme.md` on `main`): Google Chrome 152.0.7977.64 and Chromium 152 are installed (the README names only `CHROMEWEBDRIVER`, the stable package puts the binary at `/usr/bin/google-chrome`, confirm with the preflight step), Docker client and server 28.0.4, Docker Compose 2.38.2, PostgreSQL 16.15 installed with its service disabled by default (so `psql` and `createdb` exist on the runner even without the service), Node.js 22.23.2, no pnpm (it comes from `pnpm/action-setup` and `packageManager` as today). Cite the README yourself in `docs/ci.md` with the date you read it. The runner's Docker and Compose are not the Engine 29.1.3 and Compose 5.1.4 pair T05a names, which is one more reason that qualification stays a separate obligation.

## Part 1. The SQL job

### The runner

`manager/test/database/run-all.mjs`, plain Node, no dependency beyond `pg` which the manager already has:

1. Names the nine task databases in one table: `t01_test` with `T01_TEST_PG_PORT`, then `t04a_test`, `t04b_test`, `t06_test`, `t08_test`, `t09_test`, `t10_test`, `t11_test`, `t12_test` with their variables. This table is the only place the list lives, and `docs/ci.md` points at it.
2. Refuses to start, in words naming the variable, when any variable is unset or is not a port number. The suites themselves only ever connect to `127.0.0.1`, so the port is the whole configuration.
3. Connects to every one of the nine databases as `postgres` with a ten second timeout before running anything, and refuses in words naming the database when one does not answer. This is the preflight the T20 continuation asked for: absent configuration must fail here, not produce skips further down.
4. Runs `tsx --conditions=development --test --test-reporter=tap 'test/database/**/*.test.ts'` as a child process with `DATABASE_URL` set to the `t04b_test` URL (the config module requires the variable at load) and the environment passed through, streams its output, and reads the summary lines `# fail` and `# skipped`.
5. Exits non-zero when the child does, when `# fail` is not 0, or when `# skipped` is not 0, printing all three counts. A skipped suite is a suite that did not run, and this runner exists so that is never counted as green.

Package script in `manager/package.json`: `"test:database": "node test/database/run-all.mjs"`. The 33 suite files are not touched.

### The job

A second job `database` in `checks.yml`, beside `checks`, both required. A Postgres 16 service container pinned by digest (`postgres:16-alpine@sha256:...`, the digest resolved on the day and written with the date in a comment, as the repository does for its other pins), `POSTGRES_HOST_AUTH_METHOD: trust`, `POSTGRES_USER: postgres`, port 5432 published, a health check. A step creates the nine databases through `docker exec ${{ job.services.postgres.id }} createdb -U postgres <name>` or an equivalent `psql` loop, so the runner needs no client of its own. The nine variables are set to `5432` in the job's `env`. Then install, common build, and `pnpm --filter @streaming-infra-manager/api test:database`.

Locally the same script runs against the disposable container the briefs describe: `docker run --rm -d --name t20-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` (digest resolved 2026-09-10, the same pin the jobs use), create the nine databases, export the nine variables as 55432, run the script. Record the count it prints. At the baseline it was 497 tests, 0 skipped, before the T09 slice added its files.

## Part 2. The browser job

### The script

`frontend/package.json` gets `"test:browser": "node --import tsx --conditions=development --test --test-concurrency=1 'test/**/*.test.mjs'"`. The `tsx` import is required: `mock-engine-observations.test.mjs` imports the manager's TypeScript through `dev/mock-engine.mjs`, whose `.js` import specifiers only tsx rewrites, so under plain `node` that file fails with a missing `omeXml.js` (Fable hit this on 2026-09-10 and confirmed it passes under tsx from the frontend package). Run the script from the frontend package so `tsx` resolves from its `node_modules`. That glob takes the fourteen Chrome suites, the five Node-only suites and `test/support/chrome-protocol.test.mjs`. Concurrency 1 because each Chrome suite starts its own Vite and its own Chrome, and the roadmap records that these were only ever run one at a time. Measure the wall time of the whole script locally and record it in `docs/ci.md`. If it is under three minutes at concurrency 2 with no failure in three consecutive runs, concurrency 2 is acceptable, otherwise keep 1.

`frontend/test/support/chrome.mjs` already throws when the executable is missing, which is the right behaviour: a missing Chrome is a failed check, never a passed one. Add a one-line diagnostic at launch naming the executable path and the version, so a run's log says which Chrome it used.

### The job

A third job `browser` in `checks.yml`, required. `ubuntu-latest` carries Google Chrome. Verify this against the runner image documentation (the `actions/runner-images` repository's Ubuntu 24.04 README) and set `CHROME_BIN` to the path it documents. A preflight step runs `test -x "$CHROME_BIN"` and `"$CHROME_BIN" --version`, failing in words when the binary is not there. The job has the same Postgres service as the database job with only `t09_test` created and `T09_TEST_PG_PORT: 5432`, because the connected transfer suite from the T09 slice signs into a real manager over real Postgres. Install, common build, then `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser`. Screenshots and evidence go where the suites already put them, under `RUNNER_TEMP`. Do not add an artifact upload action unless you run the repository's four provenance checks on it (publish age, signature and attestation, the installed tree where applicable, known malware) and record the results in `docs/ci.md`. Without that record there is no upload.

## Part 3. The native transport suites

`git mv` the three files to `manager/test/native/`. Their relative imports of `../support/...` and `../../src/...` resolve the same from there, confirm by running them. Script `"test:native": "tsx --conditions=development --test 'test/native/**/*.test.ts'"` in `manager/package.json`, and a step in the existing `checks` job after the manager unit tests, with the same `DATABASE_URL` placeholder. `test:integration` keeps its glob and now holds only the suites that create deployments.

Leave a note at the old location: a short paragraph in `manager/test/integration/README.md` under "Separate local regression suites" saying the three native files moved to `test/native/` on 2026-09-10 and how to run them. That README's opening paragraph also still describes the harness as "merged into local main-v2 on 2026-09-09 at Levi's request", correct it to the branch and the date.

## Part 4. The Docker-backed workflow

Restructure `docker-checks.yml` into separate jobs so one failure never hides another and each shows by name in the run: `srs-parser` (T02), `ome-gate` (T03), `image-race` (T05a) and the existing `integration` (T10, now carrying T01's file). The three harness jobs need Docker and the checked-out repository with the submodule, no manager, no secret. The integration job keeps its secret gate and its manager. The whole workflow stays `workflow_dispatch` only, and its first run on a runner remains Levi's, said in `docs/ci.md`.

### T02: the real parser on distinct directives

`manager/test/docker/srs-check-isolation.sh` with a `tsx` driver `manager/test/docker/srsCheckIsolation.ts`. The driver calls the real `checkEngineConfig` from `manager/src/domain/engineConfig/engineConfigCheck.ts` with the real command runner, the SRS image pinned by digest (resolve `ossrs/srs:6` on the day, write the digest and the date in the script as `ome-admission-gate.sh` does), a temporary scratch directory, and the stack's own SRS template from the submodule as `template`. It runs eight checks at once: four valid files that differ in one directive's value each, four invalid files that each break a different directive. It asserts that every valid file is accepted, that every invalid file is refused with a message naming its own broken directive and never another file's, and that the scratch directory holds nothing afterwards. Exit 0 on pass, 1 on a wrong answer, 2 on a harness problem, the same convention as the OME gate. Run it locally on this laptop (arm64, Docker 29.7.2) and record the result in the script's header the way the OME gate records its evidence.

### T01: the container-backed startup failure

`manager/test/integration/engine-startup-failure.test.ts`, a file of the signed-in suite using the T10 client in `helpers.ts`. It creates a streamer deployment the way `profiles.test.ts` does, waits for `RUNNING`, then `PUT /profiles/:name/engine-config` with an SRS file that the manager's check accepts and SRS exits on at start, waits for the rollout to end in the state the watch reports for an engine that did not stay up with the previous file restored (read `common/src/engineConfigRollout.ts`, the states are `applying`, `watching`, `applied`, `reverting`, `reverted`, `failed`, `interrupted`, `superseded`, and `rolloutNotice` says what each shows), asserts the deployment is `RUNNING` again on the previous file, asserts the notice offers what the design says it offers, and removes the deployment through the run's own cleanup.

The hard part is the file. Before writing the test, find an SRS configuration that passes `srs -t` and makes `srs` exit at start, and prove both with the pinned image in isolation: one `docker run` for the parse, one for the start, exit codes and the engine's own last lines recorded. Candidates worth trying first: a `listen` directive naming the same port twice, a port outside the valid range, and two listeners on one port across sections. Write the winning file and the two observations into the test's header comment. If SRS refuses every such file at parse time, do the same with OvenMediaEngine and its contract check. If neither engine yields such a file, say so in the report and in `docs/ci.md`, and do not ship a test that cannot fail for the right reason.

This file cannot run here: it needs the whole stack deployed on the runner. It is typechecked, reviewed, and run for the first time by Levi's dispatch of the workflow. `docs/ci.md` says exactly that.

### T03 and T05a

Wire the two existing scripts as their own jobs. `shared-image-race.sh` prints the daemon and Compose versions it ran on, keep a step that records them in the log. State in `docs/ci.md` that the T05a qualification on Engine 29.1.3 with Compose 5.1.4 is a separate obligation the runner's versions do not discharge. Run both scripts locally once more on this laptop and record the results.

## Part 5. Docs

- `docs/ci.md`, rewritten: the three required jobs and what each proves and does not prove, the per-push wall time you measured, how to run each script locally, the manual workflow's four jobs and the integration job, the secret it needs, the pins with their dates and digests, the T01 file's unexecuted status, the T05a qualification obligation, and the standing sentence that a green check says nothing about a host, a Bee node or funds.
- `README.md`: a line under the layout or a short "Checks" section pointing at `docs/ci.md`.
- `manager/test/integration/README.md`: as in Part 3, plus the T01 file in its table.
- `docs/handover/main-v2-remediation.md`: a dated section for this slice and the T20 row of the table.

## How to work

- Read first: `.github/workflows/checks.yml`, `docker-checks.yml`, `docs/ci.md`, `docs/consensus/T20-CONTINUATION.md` (historical where it disagrees with the handover), `manager/test/database/chequebookOperations.test.ts` (the gating shape every SQL file shares), `frontend/test/support/chrome.mjs`, `frontend/test/support/transfer-fixture.mjs`, the two Docker scripts, `manager/src/domain/engineConfig/engineConfigCheck.ts`, `manager/test/integration/README.md`, `helpers.ts` and `profiles.test.ts`.
- The workflow files cannot run here. Validate their YAML with `ruby -ryaml -e 'YAML.load_file(ARGV[0])' <file>` (ruby is at `/usr/bin/ruby`, there is no actionlint), and validate the runner's facts (Chrome path, Docker and Compose presence, `createdb` in the Postgres image) against the runner image documentation, citing what you read.
- Tests first where there is code: the run-all script gets a Node test in `manager/test/unit/` that feeds it fake summaries and fake environments and asserts every refusal and every count rule. The `tsx` driver for T02 gets its assertions exercised against recorded outputs before the live run.
- Every pin by digest carries the date it was resolved. No new action without the four provenance checks recorded.
- One fix per commit, files added by path, never `git add -A`, nothing under `.scratch/`, no em-dashes or semicolons in prose, no attribution footers.
- Never kill by pattern. Stop only your own containers by name. `timeout` does not exist on macOS. The shell is zsh.
- Before handing over: `test:database` with the nine databases on your container (record the counts), `test:browser` in full (record the wall time and the counts), `test:native`, the manager unit suite, common, frontend unit, all typechecks, the three Docker scripts locally, `git diff --check`, the prose grep on docs and workflow comments. Leave nothing running and nothing uncommitted.
- Report: the head SHA and commits, each part, the commands and their summary lines, the runner facts you verified and where, what could not be executed here and why, the measured wall times, and the cost note: the checks workflow after this slice runs three jobs per push, estimate their minutes from your local timings so Levi can see the Actions spend.
