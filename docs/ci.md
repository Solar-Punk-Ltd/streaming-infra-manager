# Checks

Two workflows under `.github/workflows`. Neither reaches a host, a Bee node or
funds. **A green check says nothing about a host, a Bee node or funds.**

## checks, on every pull request and push to main

Three jobs, all on `ubuntu-latest`. Decision D06 of 2026-09-07: turning the
requirement on is a repository setting Levi makes after the workflow has run
once, and he keeps a bypass. Main-branch pushes still require Levi's explicit instruction.

The 2026-09-19 release transition keeps both `main` and `main-v2` in the workflow
triggers so the candidate is checked before consolidation and the final `main`
continues to run all three jobs. Levi explicitly authorized this consolidation.

**Where this stands, 2026-09-16, on `main-v2`.** This page was written at
`6dc33d1` on `feat/ai-remediation`, the head of pull request #40, which landed.
The required-checks setting is not on yet, because it waits on a first run.
Every number below says where it was measured, on this laptop, in a Debian
container or on a runner. Everything else here describes what the workflow files
declare, which is a different thing from what a runner has done.

**The file counts in this page drift, because suites are added.** Those below
were measured on 2026-09-16. Re-measure rather than trusting them: the SQL
suites are `find manager/test/database -name '*.test.ts'`, and the browser
suites are `find frontend/test -name '*.test.mjs'`.

### checks

Check out the repository with the stack submodule, install from the frozen
lockfile, build common, type checks in every package with the test files
included, the unit suites of common, manager and frontend, the native transport
suites, the frontend build. The submodule is there because four manager unit
tests compare the guides and the contract fixtures against the branch the pin
names, and a checkout without it fails them for a reason unrelated to the code
(run 35069103361, 2026-09-16). The submodule URL is HTTPS and the stack
repository is public, so the default token fetches it.

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
run goes around the runner, and to run a single file by hand give it both of the
variables the runner pins:

```sh
SHLS_ROOT="$(mktemp -d)" BEE_LOCAL_HOST=127.0.0.1 \
  tsx --conditions=development --test test/unit/<file>
```

`BEE_LOCAL_HOST` matters as much as the root. `src/domain/localHost.ts` answers
`host.docker.internal` when `/.dockerenv` is there, so the Bee target locator's
own test passes on a laptop and fails inside a container unless the variable is
pinned. The runner pins both, which is why a file run through it behaves the
same in either place.

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

The 34 SQL suites in `manager/test/database/` (2026-09-16), each against the
task database it owns, through `manager/test/database/run-all.mjs`.

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
empty one. A suite skipped at the describe level registers no test, so 34
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

What it proves: every one of those tests runs against a real PostgreSQL, and
none of them was skipped or quietly never started. The count was 526 when this
was measured on 2026-09-16 against a disposable Postgres, and it grows with the suites.

What it does not prove: anything about a deployment database. Every suite
connects to `127.0.0.1` and creates a schema of its own with synthetic rows.

The suite files run one at a time. Measured here on 2026-09-10 against nine
disposable databases: at the test runner's default file concurrency, two of
four full runs failed, once on the lock-ordering case in
`chequebookTargets.test.ts` and once on the spent-budget deadline in
`chequebookConnected.test.ts`. Both read the clock while another connection
holds a lock, so a loaded machine beats them and neither failure was a rule
being wrong. Serialized, every run since has passed. **It costs 235 seconds**,
the longest of the six full runs measured here and on two review worktrees,
and that one number is what the estimate below is built from. A required check
that fails half the time is worth more than the difference.

### browser

The 32 suites under `frontend/test/` (2026-09-16), of which 18 drive a real
headless Chrome, 9 of those against a real Vite they start themselves and the
rest against a fixture server, and 14 need no browser. They live outside `pnpm test`, which only takes `src`,
so they ran nowhere on a pull request.
`pnpm --filter @streaming-infra-manager/frontend-prototype test:browser` takes
all of them, through `frontend/test/run-all.mjs`.

That runner is the browser counterpart of the SQL one and judges a run by the
same shared rules: a skipped test, a suite that skipped itself whole, a run of
no tests, a missing summary, a signal or a non-zero exit each stop it in
words. Checked by running it with `T09_TEST_PG_PORT` unset, which is exactly
the hole it exists to close: on 2026-09-10, before the suites below were
added, 163 passed, 3 skipped, refused, exit 1.

The suites run under `node --import tsx --conditions=development` and not
under plain `node`, because `mock-engine-observations.test.mjs` reaches the
manager's TypeScript through `dev/mock-engine.mjs`, whose `.js` import
specifiers only tsx rewrites. Under plain `node` that one file fails on a
missing `omeXml.js`.

One file at a time, each in a child of its own, because each Chrome suite
starts its own Vite and its own Chrome. Concurrency 2 was not qualified: the
rule was three consecutive failure-free runs under three minutes, and the same
class of clock-reading
failure had already shown up in the SQL job under parallel files, on a laptop
with three times the runner's cores. If it is worth the risk later, the
measurement to beat is below.

**What the first runner run showed, and what changed.** Run 34477086525 on
2026-09-10 was the first time this job ran on a GitHub runner, against Chrome
152.0.7977.82 at `/usr/bin/google-chrome`. Every suite that drove that Chrome
ended `not ok` with `ENOTEMPTY: directory not empty, rmdir
'/tmp/t15-chrome-XXXX/Default'`, and the job was cancelled at its thirty
minute limit with a chrome, two chrome_crashpad_handler processes and several
node processes in the runner's own orphan list. The tests themselves had
passed. The teardown signalled the one process `spawn` returned, and on Linux
Chrome's helpers outlive it by a moment and keep writing into the profile the
removal is walking. Node's test runner then stops at the first `after` hook
that throws, so the next hook never ran, the browser it owned stayed alive,
and a live child keeps its file's process alive for as long as the job lasts.

Chrome is now started detached, so its pid is a process group and one signal
reaches the crashpad handler and the renderers with it. The profile removal
retries ENOTEMPTY, EBUSY and ENOTDIR for ten seconds and then names the path
through `t.diagnostic` instead of failing the suite, because a temporary
directory left behind is housekeeping and never a failed test. Every fixture
teardown now runs each of its own steps whatever an earlier one did and
reports the first failure at the end, and the forked connected manager ends
itself when the pid that started it is gone. **The runner bounds each suite
file at 600 seconds**, in a child of its own, kills it with its process group
if it outruns that, and refuses the run naming the file. A suite that hangs is
a named failure rather than a cancelled job that says nothing about the other
thirty-one files.

Checked on Linux before any of it went anywhere: the whole set in a Debian
container against Chromium 152.0.7977.82, which is the version the runner's
Google Chrome was, came back 183 tests, 0 failed, 0 skipped, with no
`hookFailed`, no leftover profile and no process of its own left running.

**What the second runner run showed, and what changed.** Run 34492919531 on
2026-09-10 passed every suite but `pool-draft-browser.test.mjs`, which timed
out after 27 seconds on a wait that counted entries in
`performance.getEntriesByType('resource')`, a list that holds the first 250
completed requests of a document and nothing after that, which a Vite page
fills with its own modules before a test asks anything. Waits now count
completed requests through a `PerformanceObserver`, which is handed every
entry whatever that list holds, and every browser session caps the list at ten
entries so a wait that reads it fails on a laptop rather than only on a
runner. The same run printed `Re-optimizing dependencies because vite config
has changed` at the start of five suites, because the suites that start a Vite
with a plugin set of their own all shared one cache directory, so each
one now builds in `frontend/node_modules/.vite-t09/<suite>` and that line
appears in neither of two full runs measured here.

**What the third runner run showed, and what changed.** Run 34498885341 on
2026-09-10 passed every suite but `transfer-recovery-browser.test.mjs`, whose
fourth case failed 646 ms in with
`TypeError: Cannot read properties of null (reading 'innerText')`. The helper
that waits for text on the page read `document.body.innerText` in the instant
after `Page.navigate`, when the committed document has no body yet, so a read
that would have polled again threw instead. That shape was everywhere: reads
of a `querySelector` result that can be null, and waits that found a control in
one evaluate and clicked it in the next, which on a slow machine is two reads
of a page that renders in between. Every one of them in every Chrome
suite is now a wait naming what it waits for, or a read that answers rather
than throwing when the element is absent, through shared helpers in
`frontend/test/support/chrome.mjs`.

**Running the suites at the runner's speed.** `BROWSER_CPU_THROTTLE=4` applies
`Emulation.setCPUThrottlingRate` to every page session the harness opens,
second tabs included, so a race that only appears on the job's two cores
appears on a twelve core laptop as well, and the runner and each launch print
the rate. Qualified here with three consecutive green full runs at rate 4
(544 s, 473 s and 424 s of wall clock, 208 tests each), one at rate 6 (462 s)
and one unthrottled (360 s), all with the Postgres container up so the
connected suite ran rather than skipped. The slowest single file was
`transfer-polling-browser.test.mjs` at 168 s throttled against 144 s
unthrottled, which is well inside the 600 second per-file bound, and that file
is slow because it waits out real polling intervals rather than because it is
throttled.

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

A failing suite ends at once rather than at the runner's bound. Node runs a
test's `after` hooks in registration order and stops at the first one that
throws, and every hook behind it is then left undone. The suites that own
a Vite server directly registered its teardown before `launchChrome` registers
Chrome's, so anything that went wrong closing Vite left a detached browser
running and its socket open, and the file never exited. On 2026-09-11
`versions-layout.test.mjs` failed one case with a Chrome protocol timeout,
reported its cases, and was killed by the runner with its process group ten
minutes later. Ten billed minutes for one failing case.

`endViteServer` in `frontend/test/support/teardown.mjs` is the answer, and 8 of
the 9 suites that own a Vite server go through it. The exception is
`frontend/test/version-approval.test.mjs`, which still closes its own server in
a `t.after` of its own, which is the shape this paragraph describes as the bug.
It has not bitten yet and it is the one file left to move. It never throws, so the Chrome teardown behind it
always runs, and it gives the close a bound so a server that will not finish
costs a suite ten seconds rather than the run its remaining minutes. What went
wrong reaches the log as a diagnostic, which is evidence without being a
second failure on top of the first. Measured both ways on 2026-09-11: with the
old teardown a close that throws left the file running past ninety seconds
with no summary printed and Chrome alive, and with this one the same file
reports and ends in six seconds. What it cannot do is free a Vite that never
released its own watcher: a close that does nothing at all still holds the
file through handles no caller can reach.

Screenshots and fixture evidence go under `RUNNER_TEMP` when the job sets one
and the OS temp directory otherwise, each in a directory the suite makes for
itself. Three suites used to write to a fixed `/private/tmp/...` path instead,
which on a Linux runner as an ordinary user cannot be created at all, so they
would have failed on this job's first run. Nothing is uploaded. An upload
action would be a new action, and a new action needs the repository's four
provenance checks recorded here first.

### What a push costs

Measured on this laptop on 2026-09-10 (12 cores, arm64), and the browser row
again on 2026-09-11 with the twenty-five support cases the throttle work
added. Test and build time only, without install. Each number is the longest run of that step measured
here, so the estimate below is built on the slow end rather than the lucky one:

| Step | Wall time |
| --- | --- |
| common build | 1 s |
| type checks, every package | 6 s |
| unit suites, common 354, manager 2474, frontend 153 (2026-09-16) | 25 s |
| native transport suites, 7 | 3 s |
| frontend build | 6 s |
| SQL suites, one file at a time. 526 cases across 34 files, measured 2026-09-16 against a disposable Postgres | 235 s |
| browser suites, one child per file. Case count last measured 208 on 2026-09-10 across 27 files, and there are 32 now | 360 s |

The three jobs run in parallel in wall-clock time but GitHub bills each one
separately, so a push costs the sum. A standard GitHub-hosted Linux runner on
a private repository has two virtual cores against this laptop's twelve, and
the work that dominates is serialized, so take the numbers above at roughly
one and a half to two and a half times, plus about a minute of install and
common build per job.

That puts `checks` at about 3 minutes, `database` at about 9, and `browser` at
about 13. **Estimate about 25 Actions minutes per push, somewhere between 19
and 30.** The browser job is more than half of it. The first real run replaces
this estimate with a measurement.

**A decision that is Levi's, not this page's.** Whether all three jobs stay
required on every push, or the browser job moves to a schedule or a manual
dispatch, is a spend question. Keeping all three required is what the D06
agreement says and what this slice built. Moving the browser job off every
push would take roughly half the minutes back and would mean a pull request
can go green while every Chrome suite has not run on it.

**Measured on the runner, 2026-09-10.** The first two runs of this workflow on
`ubuntu-latest` took 1.7 and 1.8 minutes for `checks`, 3.8 and 4.1 minutes for
`database`, and 6.8 minutes for `browser` once its teardown held (run
34492919531, install included). That is about 12 billed minutes a push with all
three jobs required, half the laptop-derived estimate above, because the
browser suites spend most of their time waiting on a page rather than on a
core. The estimate stays for the reasoning, the measurement is the number.

## docker-backed checks, by hand

`workflow_dispatch` only, four jobs, so one failure never hides another and
each shows by name in the run.

**Never dispatched, and every run it has had failed.** Checked on GitHub on
2026-09-16: the workflow has five runs, all of them triggered by push events
between 2026-09-10 and 2026-09-11, and all five failed. There has been no run
since 2026-09-11, and no `workflow_dispatch` is recorded at all. So no job in it
has ever completed on a runner, and the four container harnesses it names have
never executed anywhere but a laptop. The first real run is Levi's, and it is
the check of the workflow itself: paths, timings and image pulls may need a fix.

**It could not have run before 2026-09-11.** From the day the file was written
it set two of the integration job's paths from `${{ runner.temp }}` in a
job-level `env:` block. The runner context does not exist there, only inside a
step, and GitHub rejects a workflow that reads it whole rather than at the job
that does it. Every push therefore produced a red run named by the file path
instead of by the workflow name, and a manual dispatch would have refused to
start. The two paths are now written to `$GITHUB_ENV` from a step. A rejected
file announces itself the same way every time, so after any edit under
`.github/workflows` one command is the check:

```sh
gh run list --limit 5
```

A run whose workflow column reads `.github/workflows/<file>` rather than the
workflow's own name is a rejected file, whatever its title says.

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

Run here on 2026-09-10 after that change: pass in 132 seconds, the number the
script's own header records. SRT in, one segment in the media playlist, a
signed opening admission call for `video/gate` and a closing call after the
publisher ended, on `airensoft/ovenmediaengine@sha256:172da912...`.

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

**2026-09-19, v3.1 compatibility run.** Run 35444459944 first exercised this
workflow by dispatch. SRS parser isolation, OME admission and image isolation
passed. Integration exposed a stale test topology: without `.stack-commit`
the manager used a mutable checkout, which recovery correctly refused, and
its unprivileged process could not remove Bee-owned directories.

The integration job now writes the exact gitlink to `.stack-commit`, starts
only the manager as root to match the production API container, and waits for
the pinned bundled version to publish an immutable build. `/health` alone does
not prove that asynchronous build has finished. The gate checks its status,
layout, build id, commit and root before any test starts. The test client stays
unprivileged. Rollback and complete-removal assertions remain unchanged.

`engine-startup-failure.test.ts` is T01's container-backed startup failure: a config file the manager's own check accepts
and SRS exits on at start, asserted to end the rollout in `reverted` with the
deployment back `RUNNING` on the previous file and a card that offers nothing
to press. The file is the version's own template with one added line,
`work_dir /no/such/directory;`, and the two observations that make that the
right file, one for the parse and one for the start, are in the test's header
with the image digest and the date, taken again on the corrected pin the day
it was corrected. The failed first run above is recorded separately from the corrected topology's
acceptance result.

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

`.github/CODEOWNERS` covers `/.github/`, so a change to either workflow file
needs an owner's review. It was added on 2026-09-11 and is broader than the
`.github/workflows/` this section first recommended, which is the right way
round: a change to any file under `.github` can alter what a green pull request
means.

There is still no workflow lint and no secret scanner, so beyond that review the
person reading a diff is the whole control. A pull request could empty the three
required jobs while keeping their names, and every check would go green.

**One thing is still open and it is Levi's**, because it is a repository
setting rather than a file: "require review from code owners" has to be turned
on in branch protection for the CODEOWNERS entry to block rather than merely
request.

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

### A failure only the runner sees

This laptop is not the machine the browser job runs on, and three races reached
`main-v2` that only a runner could show, each costing a push to see and another
to test a guess at. The fourth was caught here instead:

```sh
sh frontend/test/docker/browser-on-two-cores.sh pool-draft-browser.test.mjs
```

Two pinned cores, 7 GB and the same Chrome major as the runner, with the
checkout copied in read-only. Pass a suite file to run one, nothing to run them
all. It reproduced that failure at about one run in three and then passed six
times with the fix, which is the shape of evidence worth pushing on.

Two things about it. Pinning cores rather than granting core-time is the whole
trick, because Vite and esbuild start a worker per core the kernel reports, so
a time quota alone makes a machine much harsher than the runner and fails
suites the runner passes. And the connected transfer suite is not served a
PostgreSQL there, so it skips and the runner refuses it. That one refusal is
expected and means nothing.

A third thing, learned on the estate's verification box on 2026-09-17, where
`pool-draft-browser.test.mjs` failed on every commit while GitHub's runner,
this laptop and the two-core container all passed it. The fixture told the
wizard's two fresh reads from the store's ordinary ones by the `Cache-Control`
header a `no-store` fetch carries, and that header is the browser's to add:
the box's Chromium build sends none for it, Chrome elsewhere sends
`no-cache`. The page behaved the same everywhere. Since 7f3f094 the suite marks
its own no-store fetches with a request header set by a script the harness
adds before navigation, so no browser build can drop it, and the timeout of
that wait reports the route, the dialog, every held read with its headers, the
page's exceptions and the requests the harness blocked. A fixture that reads a
browser's own headers is coupled to the browser build.
