# feat: every deploy attempt holds its project until its containers prove it over, and shared-tag builds wait for each other (T05a)

Branch `fix/t05a-shared-image-guard`, thirty-one commits on top of main-v2 at d046ebf, the last twelve from the two reviews. Not pushed. Row T05a of the consensus set, see `../issues/t05a-shared-image-guard.md` and the PRD's "Question 1, T05a" (round 6). Independent of the other branches in code, with the merge notes below. Migration 016. No new dependency. Reviews pending, see below.

## What was wrong

The stack names its built images by service alone, `stream-uploader` and `stream-client`, so two deployments building at once move one shared tag. Compose creates a container by tag name, so a build that finishes and moves the tag while the other project sits between its own build and its container creation puts one deployment's content under the other's container. R04 was reproduced in review on Engine 29.7.2 and Compose 5.5.1, and the harness on this branch reproduces it again: 6 of 20 creations wrong in the control run. Nothing in the manager kept two deploys apart, and nothing recorded which Compose the api container runs.

## What changed

- **The flag.** A version's contract says whether its built services share image tags: `features.sharedImageTags` is true when a service with a `build:` also declares an `image:`, as both branches do today, false once no built service names its image, and true when the compose file cannot be read, because unknown must not run concurrently. A contract stored by an older manager has no flag and reads as shared.
- **The row.** Migration 016 adds `deploy_attempts`: daemon id (from `docker info`, so a lock never crosses hosts), project, job id, kind (shared or fixed), the services the attempt touches, every container id of the project before the attempt spawned, state (open, released, blocked), reason, timestamps, and who released it. A partial index covers the unresolved rows per daemon and project.
- **The two rules**, in `manager/src/domain/deployAttempts.ts`. The project guard: every attempt, whatever its tags, holds its Compose project until it resolves, so nothing else creates containers there meanwhile and a new container id is attributable to the attempt. The daemon lock: an attempt on a version with shared tags holds the daemon against every other such attempt, and a fixed-image attempt of another project runs beside anything. An attempt resolves by evidence only: released when every service it touched shows a container id that was not in the pre-job set, blocked naming the services that do not. Compose creates every container after every build, so that proves the build phase finished and no delayed export can follow. Elapsed time never releases anything.
- **Admission.** `open` applies the rules and inserts in one transaction under a per-daemon advisory lock, so two attempts admitted together cannot both pass. The orchestrator asks before the claim, so a refusal changes nothing, and opens the attempt in `runJob` after the transition and before the spawn, with the project's container ids as they are. When the script ends, whatever its exit code, the attempt is judged by the project's containers. A daemon that does not answer leaves it open, and boot judges every open attempt of the daemon, released or blocked, never by time. A refused deploy answers 409 `deploy_attempt_refused` with the reason in `message`.
- **The release.** `GET /versions/attempts` lists the daemon's unresolved attempts without the container ids. `POST /versions/attempts/:id/release` takes the job id typed back, refuses a mismatch or a missing id with 400 and an unknown attempt with 404, and records the signed-in user. The rule is shared: `attemptReleaseProblem` in `common/src/deployAttempts.ts` is what the manager applies to the request and the dialog to the field.
- **The pages.** The Versions page lists every unresolved attempt above the table, because an attempt on a version with shared tags holds every such deploy on the host. A deployment's own page carries a card when an attempt on it needs a person: blocked, or still open with no deploy in flight, which is one the manager could not judge. Both open one dialog that says what to check on the host and takes the job id. An open attempt behind a running deploy is that deploy and offers no release. The store reloads on `attempt.changed` and on reconnect.
- **The pin.** The api image's Compose plugin is `docker-cli-compose=5.1.4-r1`, the version the host's api container was read at on 2026-09-07, with a test that keeps it named.
- **The harness.** `manager/test/docker/shared-image-race.sh` runs two Compose projects building one image name: a controlled interleaving that puts b's content under a's container deterministically, a bounded control of free rounds under the shared tag that reports its wrong-content count, and the corrected variant with the `image:` line removed, where zero wrong content is asserted and a missing container or a failed build is classified apart. Every container is checked by exit code and exact content. Never on the host.

## Commits

1. `79d1c7e` test: a version's contract says whether its built services share image tags. Fails on the missing flag.
2. `1dd16f3` feat: a version's contract says whether its built services share image tags
3. `378b7ed` test: when a deploy attempt is over, and what may run beside it. Fails on a missing module.
4. `8cc3ef1` feat: the rules that end a deploy attempt and admit the next
5. `bc18200` test: two deploys cannot create containers in one project at once, and two shared-tag builds cannot run on one daemon at once. Fails on the orchestrator's constructor.
6. `b386f57` feat: every deploy attempt holds its project until its containers prove it over, and shared-tag builds wait for each other on the daemon
7. `46d7bfa` chore: pin the api image's Compose plugin to the version the host runs and the harness verifies
8. `c02b4cf` test: the blocked deploy attempts as the page reads them, and the typed release that ends one. Fails on a missing module.
9. `6a8cfae` feat: the attempts that hold a project or the daemon are listed, and a blocked one is released by typing its job id
10. `1a31d01` test: a harness that reproduces the shared image tag race under Compose and shows per-project image names close it
11. `de05734` test: what a page may know about a deploy attempt, how it reads, and what releasing one requires typed. Fails on a missing module.
12. `7ada0a6` feat: what a page may know about a deploy attempt, and the release rule, shared by the manager and the pages
13. `16c38c8` refactor: the manager's attempt states and the release rule come from the shared package
14. `b8ffea4` test: the pages are told when an attempt opens, is judged or is released, and a refused deploy carries its reason where the page reads it. Three fail on purpose.
15. `5c5670b` feat: the pages are told when an attempt opens, is judged or is released, and a refused deploy says why where the page reads it
16. `bf13fab` feat: the pages show what a deploy attempt holds, and a person ends a blocked one by typing its job id
17. `1550bdc` feat: the mock opens an attempt per deploy, seeds a blocked one on the failed deployment, and refuses and releases the way the manager does
18. `f000741` test: a refused deploy says a running attempt resolves on its own and a blocked one waits for a person. Fails on purpose.
19. `dce905c` fix: a refused deploy says a blocked attempt waits for a person, and only a running one resolves on its own

Commit 5 leaves the manager's typecheck red on the orchestrator's constructor until commit 6. Every other commit typechecks, and every commit's own test files pass at that commit.

## Test evidence

| # | Guarantee (acceptance line) | Test | On the test commit | After |
| --- | --- | --- | --- | --- |
| 1 | Shared tags when a built service declares an image name, fixed once none does, either declaration order, a missing compose is shared, a compose whose services cannot be read is shared with a warning naming the file, an image key with a comment after its value still names the build, and a stored contract without the flag is shared | `stackContract.test.ts` (6 new), `common/src/stackVersions.test.ts` | fail | pass |
| 2 | An attempt is released only by a container id absent from its pre-job set for every touched service, blocked naming the service otherwise, an old id seen again counts for nothing, a new id beside an old one counts. The same project is refused while any attempt on it is unresolved, a shared-tag job waits for a shared-tag holder and names it, fixed runs beside anything, other daemons and released rows are ignored, a blocked refusal says a person releases and a running one says it resolves on its own | `deployAttempt.test.ts` (11) | fail | pass |
| 3 | The attempt is opened before the script with the project's container ids and services, fixed on a fixed-image version, released or blocked on judgement whatever the exit code, the same project and a shared-tag rival are refused with no claim taken, admitted again after a release, another daemon ignored, boot releases or blocks what a gone manager left open, a script that never started blocks its attempt, a removed deployment's attempts are released and its name deploys again, a deploy that passed the check and lost the guard is refused with its deployment as it was, and the pages are told on open, judgement and release | `deployGuard.test.ts` (16) | fail | pass |
| 4 | The list carries no container ids, a typed match releases and records who, a mismatch and a missing id answer 400, an attempt that is gone answers 404 with a sentence | `attemptsRoutes.test.ts` (5) | fail | pass |
| 5 | The 409 for a refused deploy puts the reason in `message`, the field the page shows | `refusalBodies.test.ts` (1) | fail | pass |
| 6 | The Dockerfile names the Compose plugin version | `apiImage.test.ts` (1) | fail | pass |
| 7 | The typed release rule is trimmed and otherwise exact, the hold line names the deployment and the host when tags are shared, a released attempt holds nothing | `common/src/deployAttempts.test.ts` (8) | fail | pass |

Commands at the head: `cd manager && pnpm test` (531 pass), `cd common && pnpm test` (269 pass), `pnpm -r typecheck` clean across the workspace.

## Harness evidence

Run on 2026-09-08 on this laptop, Docker 29.7.2 and Compose 5.5.1, ten rounds, exit 0, no image or container left behind:

- Controlled interleaving: under the shared tag a's container ran b's content, as the race predicts. Under a per-project name it ran its own.
- Control, shared tag: 10 rounds, 20 creations, wrong content 6, missing 0, failed builds 0.
- Corrected variant, per-project image names: 10 rounds, 20 creations, wrong content 0, missing 0, failed builds 0.

The host runs Engine 29.1.3 and the api container Compose 5.1.4. The harness has not run on those versions yet. The PRD leaves that later isolated run open.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock plus the vite dev server, driven by script because the Browser pane was hidden. The mock seeds a blocked attempt on edge-test, the deployment whose last deploy failed.

- The deployment page of edge-test shows the card "A blocked deploy attempt holds this deployment" with the job id, the hold line, the reason naming srs, and Release.
- Retry on that page answers 409 and the toast reads "Starting edge-test failed. edge-test has an unresolved deploy attempt, ..." with the reason.
- The Versions page shows "Deploy attempts" above the table with the blocked row and Release.
- The dialog refuses `job-wrong` with "The job id typed does not match. This attempt is job-...", Release stays disabled, and the id typed with spaces around it releases: toast "Released job-.... edge-test can be deployed again.", the section and the card go away.
- Retry then deploys, an open attempt appears on the Versions page as Running with "Judged when its script ends" and no Release button, and the row goes when the deploy lands.
- After the reviews, against the mock restarted on the reviewed head: Start of main-stage is refused with "A deploy of edge-test (attempt job-...) is building on this daemon, and this version builds shared image tags, so its deploys wait for each other." while edge-test's blocked attempt holds the host, and with the dialog open on that attempt, a release sent from elsewhere closes it with the toast "That attempt was resolved or released meanwhile. There is nothing to release." and the section goes.

## Review

Reviewed on 2026-09-08 against the first nineteen commits by the TypeScript reviewer agent on the manager, the shared package, the harness and the Dockerfile, and by the React reviewer agent on the frontend and the mock, each in its own worktree with its own install, the typecheck and both suites run (526 and 269 pass). The TypeScript reviewer also ran the harness itself: control 6 of 20 wrong, corrected 0 of 20, nothing left behind.

TypeScript review, two high, two medium, two low, all taken, and three notes:

- High: a script that failed to spawn reached the error handler, which never judged the attempt, so a bad script path left the project guard and the daemon lock held until the next boot with nothing in the log. Commit 26 judges it there too, and commit 25's test aborts the runner.
- High: an attempt matched its project by name for ever and outlived the deployment, so a name used again was refused by a stranger's blocked attempt. Commit 27 releases a deployment's attempts as part of its removal, before the row goes, recorded as such, with the repository method and its Postgres query.
- Medium: two deploys of different deployments on shared-tag versions can both pass the check before either takes the guard, and the loser's refusal came out of the job as a failure that left its deployment ERROR with its script never run. Commit 28 cancels the claim and lets the refusal reach the caller. A deployment that exists for that deploy alone has no status to go back to and is marked failed with the reason, as before.
- Medium: the compose reader defaulted to shared only for a missing file, and a file it could not read a service from, or an image line with a comment after its value, came out as fixed images with no word. Commit 29 treats an unreadable file as shared with a warning naming it, counts any image key as a name, and the summary counts lines not understood of any file (commit 31 aligns its test).
- Low: the route parsed its id with parseInt, and the job's kind was looked up three times. Commit 30.
- Notes, not taken: the advisory lock key is a 32-bit hash of the daemon id, a collision costs a wait and never a wrong decision. Migrations 013 to 015 belong to T03, T01 and T04a on their own branches, which is why this one is 016. Boot judges an open attempt once, by evidence, and a script still finishing at that moment is blocked a moment early, the agreed trade-off.

React review, two high, four medium, two low. Taken:

- High: both pages held the attempt as copied at the click, so one resolved or released elsewhere while the dialog was open stayed on screen with a live Release button, and a submit then showed `attempt_not_found` alone. Commits 20 to 22: the manager's 404 carries a sentence, the dialog is opened by id and reads the store's latest, an attempt that drops out closes it with a toast, the manager's 404 does the same, and the title and body stay through the closing animation.
- Medium: the attempts card showed a running attempt offered a release with no reason. Commit 23 explains it the way the deployment's card does.
- Medium: the mock never applied the daemon rule, so a shared-tag deploy of another deployment was admitted while a shared-tag attempt held the host, and every attempt was shared whatever the version said. Commit 24 applies both rules with the manager's words, takes the kind from the version's contract, uses the shared unresolved rule, and says at startup what to release first.
- Low: the dialog's title flashed empty during the close, taken with the high one, and the unused `isAttemptUnresolved`, now used by the mock.

Not taken: the repository has no ESLint, a standing gap this branch did not open, raised for T20. The store's one memoized object re-renders every consumer on any change, a pattern older than this branch that `attempt.changed` now triggers on every deploy, left for a later split. The mock cannot show an attempt still open with no deploy in flight, because any open shared attempt in the seed would hold the whole mock host, and a fixed kind needs a version the branches do not have yet.

Additional commits from the reviews:

20. `7a71a88` test: a release of an attempt that is not there any more says so where the page reads it. Fails on purpose.
21. `15c74b5` fix: a release of an attempt that is gone answers a sentence, not an error code alone
22. `420ce89` fix: the release dialog reads its attempt from the live list, closes with a word when it is gone, and keeps what it showed through the close
23. `b134433` fix: the attempts card says why a running attempt is offered a release, the way the deployment's card does
24. `0a8c6c4` fix: the mock holds the host the way the manager does, takes an attempt's kind from the version's contract, and says at startup what to release first
25. `3c30818` test: a script that never started blocks its attempt, a removed deployment releases its attempts, a deploy that lost the guard is refused with its deployment as it was, and a compose file the reader cannot follow counts as shared and says so. Six fail on purpose.
26. `083872e` fix: a deploy script that never started ends its attempt as one that ended does, so the guard is not left open
27. `47b6e53` fix: removing a deployment releases its attempts, so the name can be deployed again
28. `4a7b441` fix: a deploy that passed the check and lost the guard is refused with its deployment as it was, not marked failed
29. `d470946` fix: a compose file the reader cannot follow counts as sharing image tags and says so, and an image key names the build whatever its value
30. `cd4a232` chore: the attempt route reads its id as a whole number, and a job's kind comes from the version already read
31. `3220114` test: the summary counts lines of any file the reader could not follow

## Questions for Levi

- Migration 016 has never run against a database. It adds one table and one partial index and touches no row.
- Until T05b lands (D09, your two commits), every version in use builds shared tags, so deploys of different deployments wait for each other on the daemon: the second one is refused with a toast naming the first, and the operator presses Start again once it lands. Deploys of the same deployment were already serialised by the profile's status. A version built from a commit without the two image names runs beside anything, once it is added or updated here.
- A blocked attempt needs a person. The dialog says what to check on the host: no docker compose process for the deployment and no image build in progress. Say if you want an exact command there.
- An open attempt the manager could not judge, because the daemon did not answer when the script ended, stays open until the next boot judges it. The pages offer a release for it too, since the deployment shows no deploy in flight. Boot would also judge it.
- The refusal toast repeats the blocked reason inside the sentence, so it is long. Say if you want it shorter, the reason is one line on the deployment page anyway.
- The mock reproduces the refusal wording rather than calling the manager's rule, as it does for the chequebook gate. Moving `whyAdmissionIsRefused` to the shared package is a small refactor if you want one copy.
- The Compose pin is Alpine 3.24's `5.1.4-r1`. A base image bump that drops that package version breaks the build on purpose, and the pin is then a deliberate edit.
- A new deployment's first deploy takes no check before its row is inserted, so one created while a shared-tag attempt holds the host lands ERROR with the refusal as its reason, and Start runs it once the host is free. Say if you want the wizard to refuse earlier instead.
- Until T05b, a blocked attempt on any deployment holds every shared-tag deploy on the host until a person releases it, by design: its build may still be running. The mock now starts that way, with edge-test's blocked attempt, and says so at startup.
- Merge notes: `DeploymentOrchestrator`'s constructor, `index.ts` and `server.ts`'s `ApiDeps` also change on T01 and T04a, and the `EventBus` union and the error handler on T01. The second to merge conflicts, and every one resolves by keeping both.

## Not done here

- No test runs the Postgres repository. The orchestrator and route tests run against an in-memory table that applies the same admission rules, and the SQL's lock and transaction are by design, documented in the code.
- The harness is not in CI. It needs a Docker daemon of its own and takes about three minutes.
- Nothing here touches the host, any deployment, or any credential.
