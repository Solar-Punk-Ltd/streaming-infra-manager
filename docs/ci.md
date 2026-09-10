# Checks

Two workflows under `.github/workflows`. Neither reaches a host, a Bee node or
funds. **A green check says nothing about a host, a Bee node or funds.**

## checks, required on every pull request and push to main-v2

Three jobs, all required, all on `ubuntu-latest`. Decision D06 of 2026-09-07:
turning the requirement on is a repository setting Levi makes after the
workflow has run once, and he keeps a bypass. Agents never push to `main-v2`.

### checks

Install from the frozen lockfile, build common, type checks in every package
with the test files included, the unit suites of common, manager and frontend,
the native transport suites, the frontend build.

What it proves: the code compiles, the unit-level guarantees hold, the
transport code that owns Unix sockets and forks children works, the frontend
bundles.

What it does not prove: anything that needs Docker, a Bee node, a host or
money. The manager's unit tests need a `DATABASE_URL` that names nothing,
because the config module requires the variable at load and no unit test opens
a database. `manager/test/unit/run.mjs` now supplies that placeholder itself
when the environment has none, which is what makes `pnpm -r test` work on a
fresh clone. The workflow still sets the same value on the step, and it is
kept only so a reader of the job sees what the run needs. The native suites
need no variable at all, checked with it unset, and keep the same placeholder
for the same reason.

The manager's unit run goes through `manager/test/unit/run.mjs`, which makes
one throwaway directory and hands it to the whole suite as `SHLS_ROOT`. A
deployment writes its env file into the root of the checkout it deploys, and
`envUtils` reads that root once when it is first imported, so a test that set
the variable after an import which reaches it deployed into
`manager/swarm-hls-stream` and left a `.env.<profile>` there, merged from the
developer's own `.env`. One did. `unitStackRoot.test.ts` fails in words when a
run goes around the runner, and to run a single file by hand give it a root of
its own: `SHLS_ROOT="$(mktemp -d)" tsx --conditions=development --test
test/unit/<file>`.

Two unit files hold cases that used to read the clock while a timer raced a
loaded machine, `acquireDockerBeeStream.test.ts` and `containerControl.test.ts`.
A lost-response case in the first failed one full run in four on this laptop on
2026-09-10, on a Docker POST count, and a log read in the second failed one in
six the same day, ended early by an idle gap the total bound was supposed to
beat. Neither was a wrong rule. All four cases now wait on the thing they are
about rather than on a duration, or put every exit but the one they test out of
reach. A red run in either file is therefore a broken rule and not a busy
runner: diagnose it, never retry it.

### database

The 33 SQL suites in `manager/test/database/`, each against the task database
it owns, through `manager/test/database/run-all.mjs`.

Every one of those files gates itself on a task port variable and skips
silently when the variable is unset. Nothing set them before this job existed,
so a green check said nothing about the database ownership, admission and
recovery rules they pin. The runner closes that. Before it starts anything it
refuses in words when a variable is unset or is not a port, when a file in the
directory is gated on a variable this run does not set or on none at all, and
when a database it opened is not disposable. Afterwards it refuses a failure,
a skipped test, a suite that skipped itself whole, a run that took no test at
all, a missing summary, a signal and a non-zero exit.

Those last four matter because the counts alone cannot tell a full run from an
empty one. A suite skipped at the describe level registers no test, so 33
skipped files come back as 0 tests, 0 failed, 0 skipped with a `# SKIP` marker
on each result line, and a glob that matches no file prints the same clean
zero. The rules that read those markers live in
`manager/test/support/tapJudge.mjs` and the browser runner uses the same ones.

Disposable is checked rather than asked for: with the nine connections open,
a database whose public schema already holds `_migrations` or `profiles` stops
the run by name. A task database is created empty and every suite makes a
schema of its own, so those tables mean the port leads to somebody's
deployment.

The nine databases and their variables live in one table, `TASK_DATABASES` in
that file. That table is the list. This page does not repeat it.

A Postgres 16 service container sits beside the runner with trust
authentication, and a first step creates the nine databases through the
image's own `createdb`, so the runner needs no client of its own and a service
that did not come up fails in seconds.

What it proves: those 518 tests run against a real PostgreSQL, and none of
them was skipped or quietly never started.

What it does not prove: anything about a deployment database. Every suite
connects to `127.0.0.1` and creates a schema of its own with synthetic rows.

The suite files run one at a time. Measured here on 2026-09-10 against nine
disposable databases: at the test runner's default file concurrency, two of
four full runs failed, once on the lock-ordering case in
`chequebookTargets.test.ts` and once on the spent-budget deadline in
`chequebookConnected.test.ts`. Both read the clock while another connection
holds a lock, so a loaded machine beats them and neither failure was a rule
being wrong. Serialized, every run since has passed. **It costs 182 seconds**,
the longest of the five full runs measured here and on two review worktrees,
and that one number is what the estimate below is built from. A required check
that fails half the time is worth more than the difference.

### browser

The twenty-two suites under `frontend/test/`, of which fourteen drive a real
headless Chrome against a real Vite and eight need neither. They live outside
`pnpm test`, which only takes `src`, so they ran nowhere on a pull request.
`pnpm --filter @streaming-infra-manager/frontend-prototype test:browser` takes
all of them, through `frontend/test/run-all.mjs`.

That runner is the browser counterpart of the SQL one and judges a run by the
same shared rules: a skipped test, a suite that skipped itself whole, a run of
no tests, a missing summary, a signal or a non-zero exit each stop it in
words. Checked by running it with `T09_TEST_PG_PORT` unset, which is exactly
the hole it exists to close: 153 passed, 3 skipped, refused, exit 1.

The suites run under `node --import tsx --conditions=development` and not
under plain `node`, because `mock-engine-observations.test.mjs` reaches the
manager's TypeScript through `dev/mock-engine.mjs`, whose `.js` import
specifiers only tsx rewrites. Under plain `node` that one file fails on a
missing `omeXml.js`.

One file at a time, because each Chrome suite starts its own Vite and its own
Chrome. Concurrency 2 was not qualified: the rule was three consecutive
failure-free runs under three minutes, and the same class of clock-reading
failure had already shown up in the SQL job under parallel files, on a laptop
with three times the runner's cores. If it is worth the risk later, the
measurement to beat is below.

Both the job and the runner prove the Chrome before anything starts.
`CHROME_BIN` is `/usr/bin/google-chrome`, the job's first step fails in words
when nothing executable is there, and the runner does the same again from its
own side, so a missing browser is a failed check and never a passed one. Every
launch also prints the browser it got and where it found it.

It carries the same Postgres service as the database job with `t09_test` alone,
because `transfer-connected-browser.test.mjs` signs into a real manager over a
real journal with the browser as the only client. That suite skips itself when
`T09_TEST_PG_PORT` is unset, which is the one silent-skip hole left in this
workflow: it is closed by the job setting the variable and creating the
database in a step that fails loudly, and by nothing else. Anyone removing
either would turn three passing cases into three invisible ones.

Screenshots and fixture evidence go under `RUNNER_TEMP` when the job sets one
and the OS temp directory otherwise, each in a directory the suite makes for
itself. Three suites used to write to a fixed `/private/tmp/...` path instead,
which on a Linux runner as an ordinary user cannot be created at all, so they
would have failed on this job's first run. Nothing is uploaded. An upload
action would be a new action, and a new action needs the repository's four
provenance checks recorded here first.

### What a push costs

Measured on this laptop on 2026-09-10 (12 cores, arm64), test and build time
only, without install. Each number is the longest run of that step measured
here, so the estimate below is built on the slow end rather than the lucky one:

| Step | Wall time |
| --- | --- |
| common build | 1 s |
| type checks, every package | 6 s |
| unit suites, common 321, manager 2301, frontend 100 | 18 s |
| native transport suites, 7 | 3 s |
| frontend build | 6 s |
| SQL suites, 518, one file at a time | 182 s |
| browser suites, 156 | 374 s |

The three jobs run in parallel in wall-clock time but GitHub bills each one
separately, so a push costs the sum. A standard GitHub-hosted Linux runner on
a private repository has two virtual cores against this laptop's twelve, and
the work that dominates is serialized, so take the numbers above at roughly
one and a half to two and a half times, plus about a minute of install and
common build per job.

That puts `checks` at about 3 minutes, `database` at about 7, and `browser` at
about 13. **Estimate about 23 Actions minutes per push, somewhere between 19
and 29.** The browser job is more than half of it. The first real run replaces
this estimate with a measurement.

**A decision that is Levi's, not this page's.** Whether all three jobs stay
required on every push, or the browser job moves to a schedule or a manual
dispatch, is a spend question. Keeping all three required is what the D06
agreement says and what this slice built. Moving the browser job off every
push would take roughly half the minutes back and would mean a pull request
can go green while fourteen Chrome suites have not run on it.

## docker-backed checks, by hand

`workflow_dispatch` only, four jobs, so one failure never hides another and
each shows by name in the run.

**Not run yet.** No job in this workflow has ever run on a GitHub runner. The
first run is Levi's, and it is the check of the workflow itself: paths,
timings and image pulls may need a fix.

Three of the four jobs check out the stack submodule with the default token.
That works because `Solar-Punk-Ltd/swarm-hls-stream` is public, recorded under
D12. If it is ever made private, give the job a deploy key for that repository
and never a personal access token, which would carry every repository the
person can reach into every one of these runs.

### srs-parser, T02

`manager/test/docker/srs-check-isolation.sh`, which runs the tsx driver beside
it. It calls the manager's own config checker, with its own command runner and
the engine image the stack runs, on eight files built from the stack's own SRS
template: four that change one directive's value and four that break a
different directive each. All eight checks are in flight at once.

What it proves: eight concurrent checks answer separately. Every valid file is
accepted, every refusal names the directive of its own file and none of the
other three, and the scratch directory is empty afterwards. A check that read
another check's copy would refuse with a directive the operator cannot find in
the file in front of them, which reads exactly like a real refusal.

What it does not prove: that any of those files would run. Nothing is started,
only parsed.

What it also does not prove: that the four accepted files were not mixed up
with each other. An accepted file's only observable is that nothing was said
about it. The isolation evidence is in the four refusals, each of which must
name its own directive and none of the other seven files' directives.

Locally: `bash manager/test/docker/srs-check-isolation.sh`. Exit 0 on a pass,
1 on a wrong answer, 2 on a harness problem. Run here on 2026-09-10, arm64,
Docker 29.7.2: pass, all eight right, 2 s. Re-run the same day on the
corrected image pin below, with the same four refusal strings word for word.

`SRS_CHECK_IMAGE` overrides the image and is refused unless it carries
`@sha256:`, because a tag can move under the check and the whole claim of the
harness is that its parser is a deployment's parser.

### ome-gate, T03

`manager/test/docker/ome-admission-gate.sh`. SRT in, signed admission webhook
out, HLS playlist served, all in throwaway containers on a private network,
with a fake uploader that checks the signature the way the stack's uploader
does.

Locally: `bash manager/test/docker/ome-admission-gate.sh`.

**The gate waits for its publisher's ffmpeg, and the playlist clock starts
after that.** The publisher container installs ffmpeg with `apk add` before it
publishes, and that took 93 seconds here. The harness used to check the
publisher was alive 5 seconds in, which passes while apk is still working, and
then gave the playlist 40 seconds, which expired long before ffmpeg existed.
The gate failed twice on this laptop with nothing wrong with the engine, and
for a named job in the workflow that is a gate that lies. The install now has
a budget of its own, 300 seconds, the wait is on the binary rather than on a
number of seconds, and the container exit check sits inside the loop so a
publisher that dies is still caught in seconds. The playlist budget is
unchanged at 40 seconds, because that is not where the time went.

Run here on 2026-09-10 after that change: pass in 120 seconds. SRT in, one
segment in the media playlist, a signed opening admission call for `video/gate`
and a closing call after the publisher ended, on
`airensoft/ovenmediaengine@sha256:172da912...`.

### image-race, T05a

`manager/test/docker/shared-image-race.sh`. Two Compose projects building one
image name, reproduced and then closed with per-project image names.

Locally: `bash manager/test/docker/shared-image-race.sh [rounds]`. Run here on
2026-09-10, Docker 29.7.2 and Compose 5.5.1: pass in 143 s. The controlled
interleaving reproduced the race, the bounded control hit the window three
times in 20 creations, and the corrected variant put the right content under
every one of its 20 containers.

**The T05a qualification is a separate obligation this job does not
discharge.** It names Docker Engine 29.1.3 with Compose 5.1.4. The runner
carries Engine 28.0.4 and Compose 2.38.2, and this laptop carries 29.7.2 and
5.5.1. Neither is that pair. The harness prints the versions it ran on and a
step in the job puts them in the log before any build, so a run always says
what it was on. Printing versions is not the gate.

### integration, T10 and T01

The manager built and started on the runner with Postgres beside it, the user
created from the repository secret through the CLI's stdin, and the signed-in
integration suite run against it with `MANAGER_TEST_TARGET` declared. Real
containers are built and started on the runner and nowhere else. Nothing is
paid for.

Secrets Levi sets: `ITEST_PASSWORD`, the password of the user the suite signs
in as. The workflow refuses to start without it and never prints it. Only
whether it is set is ever looked at.

**`engine-startup-failure.test.ts` has never run.** It is T01's
container-backed startup failure: a config file the manager's own check accepts
and SRS exits on at start, asserted to end the rollout in `reverted` with the
deployment back `RUNNING` on the previous file and a card that offers nothing
to press. The file is the version's own template with one added line,
`work_dir /no/such/directory;`, and the two observations that make that the
right file, one for the parse and one for the start, are in the test's header
with the image digest and the date, taken again on the corrected pin the day
it was corrected. It is typechecked and reviewed here and nothing more. Its
first execution is Levi's dispatch of this workflow.

When one of its assertions fails it prints the rollout's reason, which carries
the engine's own last lines, and the file SRS was started on carries that
deployment's SRT passphrase and its webhook token. The printed copy has every
secret-shaped value masked, by the same rule `common` uses for secret
settings. That redaction is proved by a unit test, since this file is not.

Skips are visible: a missing secret fails the first step in words, and the
suite's own preflight refuses a target that is not declared.

## Runner facts

Read from the `actions/runner-images` Ubuntu 24.04 README
(`images/ubuntu/Ubuntu2404-Readme.md` on `main`) on **2026-09-10**, image
version 20260831.293.1:

| Fact | What the README says |
| --- | --- |
| Google Chrome | 152.0.7977.64, with ChromeDriver 152.0.7977.64 |
| Chromium | 152.0.7977.0 |
| Docker | Client 28.0.4, Server 28.0.4 |
| Docker Compose | 2.38.2 |
| PostgreSQL | 16.15, service disabled by default |
| Node.js | 22.23.2 |

The README names `CHROMEWEBDRIVER` and not the browser's own path, so
`CHROME_BIN` is set to `/usr/bin/google-chrome`, where the stable package puts
it, and the job's first step proves it rather than trusting it.

`createdb` is not needed on the runner: both jobs that need databases call it
inside the Postgres service container. Verified here on 2026-09-10 against
`postgres:16-alpine` at the digest below, which is the image the commands at
the end of this page name too.

## What nothing here guards

Nothing in this repository reads these two workflow files. There is no
CODEOWNERS entry, no workflow lint and no secret scanner, so the person
reading a diff is the whole control over them. A pull request could empty the
three required jobs while keeping their names, and every check would go green.

**A recommendation for Levi, not something this slice did.** A CODEOWNERS
entry covering `.github/workflows/` with "require review from code owners"
turned on in branch protection closes it. Both are his: his handle, his
settings.

## Pinning

Actions are pinned by commit with the tag in a comment. **No action was added
or moved in this slice**, so no new provenance check was owed. The three
existing pins are unchanged:

| Action | Pin |
| --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) |
| `pnpm/action-setup` | `0977fd99725f1db4007ccb2928dbb4e90d06cc86` (v6.0.10) |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0) |

pnpm itself comes from the `packageManager` field. When a pin moves, the new
tag's age and its commit are checked the way a dependency bump is: publish age,
signature and attestation, the installed tree where applicable, and known
malware, with the results recorded on this page. A release under two weeks old
is a flag and the newest release is the riskiest choice.

Container images are pinned by digest, each with the date it was resolved:

| Image | Digest | Resolved | Used by |
| --- | --- | --- | --- |
| `postgres:16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` | 2026-09-10 | database, browser, integration |
| `ossrs/srs:6` | `sha256:2be08a0fe28737bf28bae8a575bb5776e09b620366dd1e62dd4f8a41cf4310f3` | 2026-09-10 | srs-parser, and the T01 observations |
| `airensoft/ovenmediaengine` | `sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6` | 2026-09-08 | ome-gate |

## Running any of it here

From the repository root, with Docker running.

The SQL suites, on a disposable PostgreSQL of their own:

```sh
docker run --rm -d --name t20-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 \
  postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
for name in t01_test t04a_test t04b_test t06_test t08_test t09_test t10_test t11_test t12_test; do
  docker exec t20-pg createdb -U postgres "$name"
done
export T01_TEST_PG_PORT=55432 T04A_TEST_PG_PORT=55432 T04B_TEST_PG_PORT=55432 \
  T06_TEST_PG_PORT=55432 T08_TEST_PG_PORT=55432 T09_TEST_PG_PORT=55432 \
  T10_TEST_PG_PORT=55432 T11_TEST_PG_PORT=55432 T12_TEST_PG_PORT=55432
pnpm --filter @streaming-infra-manager/api test:database
docker rm -f t20-pg
```

The browser suites, with the same container up so the connected one runs too.
Without `T09_TEST_PG_PORT` the run ends in a refusal rather than in a pass,
which is the point of it:

```sh
export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export T09_TEST_PG_PORT=55432
pnpm --filter @streaming-infra-manager/frontend-prototype test:browser
```

The native transport suites, which need nothing at all:

```sh
pnpm --filter @streaming-infra-manager/api test:native
```

The unit suites, where the manager's run makes its own throwaway stack
checkout. One file by hand needs a root of its own, as above:

```sh
pnpm -r test
```

The three Docker harnesses, each on throwaway containers of its own run:

```sh
bash manager/test/docker/srs-check-isolation.sh
bash manager/test/docker/ome-admission-gate.sh
bash manager/test/docker/shared-image-race.sh
```

The deployment integration suite needs a running manager, a user and the
environment `op run --env-file` fills. See
[manager/test/integration/README.md](../manager/test/integration/README.md).
