# fix: a config file rollout owns the deployment it acts on, durably (T01)

Draft in progress on `fix/t01-config-ownership`, accepted checkpoint `b33aab8`, based on main-v2 `d046ebf`. Nothing is pushed or merged into main-v2. Row T01 of the consensus set is in `../issues/t01-engine-config-ownership.md`. Exact T10, T04b, final T04a and T01a `115b194` dependencies are integrated. Retained-build recovery is accepted at `c31e06d`. Explicit restore and immutable ancestry are accepted at `5e0f785`.

## Current integration boundary

Cleanup and port handover now consider explicitly owned operation holds only for the same deployment instance. Historical or partially owned holds remain conservative. The change does not resolve any hold. This shared T06/T10 integration is accepted at `b33aab8`, with43 actual SQL cases and manager types passing.

The new repository transaction owns the configuration, previous file, operation, final job, port reservations and creation guard together. Migration 028 also records the exact recovery build descriptor and an independent operation hold. A shared artifact digest and bounded manifest-byte parsing keep recovery evidence compatible with private execution copies. Cancelling a job or changing an operation label alone cannot release its recovery hold.

This repository API is not yet connected through the configuration service. Hold release, immutable runtime preparation and successful completion fencing remain open. Automatic recovery now uses the operation's retained build even after later publications. The existing service still has two failing integration cases because it changes operation revisions after reserving a job. Keep the strict job guard. Do not treat the older behavior description below as final acceptance of the combined implementation.

Cross-provider review, OpenAI-hosted. Final bounded checks passed 21 recovery-hold SQL, 32 atomic-claim SQL, 36 unchanged build-snapshot SQL, 67 affected file cases and manager types. The exact T01a merge additionally passed 57 inspect/watch checks and manager types. The earlier full manager result is 1141/1143 with the two known caller failures. The broad SQL run was interrupted and is not a passing run. Retained-build recovery passed40 actual SQL cases and manager types after RED34 failures and six controls. Explicit restore and its automatic recovery regression passed63 actual SQL cases,41 focused cases and manager types at `5e0f785`. Exact logs, owned resources and next work are in `../T01-CONTINUATION.md`.

## Earlier implementation description, to reconcile before the final draft

## What was wrong

A config file rollout lived in a closure. The previous file was read before the claim, the watch was attached to the deploy script's `done` event, and a revert wrote the previous file and only then claimed the deployment. A watcher that woke after the operator had saved another file put the older file back over the newer save. A watcher that woke after a stop recreated a stopped deployment. A watcher that woke after the deployment was removed and recreated under the same name acted on the new one. A manager restart forgot the rollout entirely: the file was applied and the engine was never verified, and the card said nothing.

## What changed

- Every rollout is a row in `engine_config_operations`: the file to put back, whether that was the template, the container the watch verified, the revisions the rollout owns, and where it stands. States: applying, watching, applied, reverting, reverted, failed, interrupted, superseded. A partial unique index holds at most one open operation per deployment instance, so a second rollout has to supersede the first inside the transaction that stores its own file.
- Three columns on `profiles` say who a rollout may act on. `instance_id` is the deployment as it exists now, and a removed and recreated name is another instance. `engine_config_revision` moves with every config file write, so a write that expects an older revision finds nothing to update. `intent_revision` moves whenever an operator acts on the deployment. `engine_config_state` mirrors the latest rollout so the row that travels to the browser says where it stands.
- The orchestrator moves the intent and closes the open operation after the claim of a stop, a removal, and every operator redeploy (start, edit, uploader start), never before the claim, so a refused action moves nothing. A rollout claims the deployment through `reserveForRollout`, the same claim without the move, because its own writes are conditional on the intent it started under.
- The watch starts from the orchestrator's success hook after RUNNING is committed, through `afterRunning` on `runReserved`, and records the container it is about. Every tick re-reads the operation and the row and ends without acting when the state is not watching, the instance differs, the status is not RUNNING, or either revision moved. Completion is conditional on the same, so a superseded rollout cannot relabel itself applied from its last healthy tick.
- A revert is owned: the ownership check, then the deploy claim, then one transaction that puts the previous file back under a new revision and marks the operation reverting, then the recreate. A refused claim ends the operation as superseded with the reason and writes nothing. A recreate that exits non-zero runs the same path from ERROR, tries the previous file once, and ends failed with both reasons kept.
- Boot reconciles what a gone manager left open. Applying becomes interrupted. Reverting becomes interrupted. Watching on a deployment that is not running becomes superseded, never a recreate. Watching with the same container still up and never restarted gets a fresh full watch. Same container restarted or gone reverts through the owned path. A different container id is superseded. An engine that cannot be inspected is interrupted. A row that is gone or a different instance is superseded. An outage is never a pass.
- Two ways out of an interruption, as rollouts of their own that supersede the interrupted one first: `POST /profiles/:name/engine-config/verify` recreates the engine on what is stored, file or template, and watches it. `POST /profiles/:name/engine-config/restore-previous` puts back the file the interrupted rollout recorded. An interrupted reset does not stay open either.
- The engine card leads with a notice per state from the shared `rolloutNotice`: recreating, verifying, reverted with the engine's reason, failed, interrupted with both actions, superseded with the reason and Verify now. Both actions ask first, the way a restart does. The config editor dialog leads with the same notice. The offline mock plays every state.

## Commits

1. `e9245af` test: who owns a config rollout, and what one that lost ownership may still do. Ten tests, nine fail on purpose.
2. `87c5cdf` fix: the row carries its instance, its config and intent revisions and the rollout state, and a deploy runs hooks after it settles
3. `a6347b6` test: an operator's stop, start or removal ends the open rollout, and boot never recreates a stopped deployment. Seven new tests, seven fail on purpose. The ownership test's pauses became waits on conditions.
4. `29b3b35` fix: an operator's stop, start, edit or removal ends the open rollout durably, and a rollout's own claim moves nothing
5. `f5c9ab0` feat: a rollout's ownership is stored in Postgres, and boot reconciles what a gone manager left open
6. `645cb3b` test: the operator's verify now and back to the previous file are routes, and the card has a notice per rollout state. Four route tests fail on purpose, the shared notice test fails on a missing module.
7. `3b8793b` feat: verify now and back to the previous file as routes, and the rollout state shared by the row, the view and the card
8. `b17a1b9` feat: the engine card says where the rollout stands and offers verify now and back to the previous file

Commits 2 and 4 leave the manager's typecheck red on `index.ts` (the service and the orchestrator gained a constructor parameter the boot wiring only gets in commit 5). Every commit's own test files pass at that commit.

## Test evidence

`manager/test/unit/engineConfigOwnership.test.ts`, the service over the in-memory profiles, the in-memory operations table and a scripted container watcher, at millisecond timings:

| # | Guarantee (acceptance line) | On the test commit | After |
| --- | --- | --- | --- |
| 1 | A then B: A is superseded, B applies, A's last healthy tick cannot relabel A applied, B's file stays, two deploys | fail | pass |
| 2 | A watch whose inspect fails ends interrupted, not still watching, and recreates nothing | fail | pass |
| 3 | Stop during the watch: the row stays STOPPED, nothing recreated, the file untouched | fail | pass |
| 4 | A failure callback that lost ownership writes nothing and launches nothing | fail | pass |
| 5 | A recreate that fails puts the previous file back, tries once, keeps both reasons, ends failed on a RUNNING row | fail | pass |
| 6 | Boot: applying becomes interrupted, nothing written or deployed | fail | pass |
| 7 | Boot: watching a healthy same container runs a fresh watch to applied | fail | pass |
| 8 | Boot: watching a deployment that is not running is superseded, nothing recreated | fail | pass |
| 9 | Boot: watching a restarted container reverts through the owned path, one deploy | fail | pass |
| 10 | Boot: a different container id is superseded, nothing deployed | fail | pass |
| 11 | Boot: an engine that cannot be inspected is interrupted, nothing deployed | fail | pass |
| 12 | Boot: a removed and recreated instance is never acted on | pass | pass |
| 13 | Verify now supersedes the interrupted rollout and watches the stored file | fail | pass |
| 14 | Verify now on an interrupted reset recreates on the template so nothing stays open | fail | pass |
| 15 | Back to the previous file puts the recorded file back through a rollout of its own | fail | pass |
| 16 | Back to the previous file is refused when no rollout is interrupted | fail | pass |

`manager/test/unit/operatorIntent.test.ts`, the real orchestrator over in-memory rows: stop moves the intent and closes the open rollout saying why, a redeploy does the same, a removal closes it before the row goes, a refused stop moves nothing, and the rollout's own claim moves nothing. Four of five failed on the test commit.

`manager/test/unit/engineConfigRoutes.test.ts`: the two POST routes answer 202 with the row, a busy deployment answers 409, a missing interrupted rollout answers 400 in the service's words. All four failed on the test commit.

`common/src/engineConfigRollout.test.ts`: the notice per state, eight tests, red on a missing module first.

Commands at the head: `cd manager && pnpm test` (516 pass), `pnpm typecheck` clean, `cd common && pnpm test` (269 pass), `pnpm -r typecheck` clean across the workspace.

## Review

Reviewed by the React reviewer agent on 2026-09-08 against the first eight commits, in its own worktree with its own install. Two high findings, both taken, plus two medium ones, both taken, and one low, noted:

- High: Verify now stayed enabled on a stopped deployment, and taking it would have started the deployment while the confirm spoke of a live publisher as a fact. Commit 9: both actions are greyed out on a stopped deployment with the reason "Start the deployment first." in the same tooltip wrapper the Restart button uses, and while a deploy runs with "Wait for the current deploy to finish." The confirm texts now say a publisher is disconnected if one is live.
- High: the config file dialog read the view once when it opened, so a dialog left open through a rollout kept saying verifying after the revert had happened. Commit 10: the dialog's notice and reason come from the live row in the store, which the event stream keeps current, and from the view only until the row is known.
- Medium: the greyed out actions gave no reason. Taken with the high finding above.
- Medium: the mock never played the failed state and its reset could leave a stale terminal notice. Commit 11: a file that says fail ends failed with the previous file back, and reset recreates whenever the row carries any rollout state.
- Low: the instance id and the two revisions reach the frontend type and the mock seed but nothing in the frontend reads them. True, they are the manager's guards. The offline mock cannot exercise them, so the ownership rules are covered by the manager's tests only.

The reviewer also checked the hook dependency arrays, the state and reason reaching the card in one snapshot, the applying reset wording, the copy, and the accessibility of the alert and its buttons, and found them sound. It noted the repo has no ESLint configuration and no component tests, which predates this branch.

Reviewed by the TypeScript reviewer agent on 2026-09-08 against the first eight commits, in its own worktree, running the manager suite six times. Two high findings, both taken, two medium ones, both taken, and four low ones, two taken and two noted:

- High: a hook that threw after RUNNING was committed was caught by the job finaliser, which marked the deployment ERROR although the deploy had succeeded, and a hook that threw after a failure replaced the script's own reason. Commit 13: each hook runs under its own catch and logs its failure. Tests in commit 12.
- High: the test of a superseded rollout's last healthy tick failed in two of six full-suite runs, because two real timer chains had to interleave one way. Commit 12: the tick is held inside inspect while the second rollout runs, so the order is fixed by the test rather than by the clock.
- Medium: a database read or write that failed inside a watch tick left the row saying watching with nothing watching it until the next restart. Commit 14: the tick loop runs under one catch that moves the operation to interrupted with the reason. Test in commit 12.
- Medium: the in-memory table overwrote a column with a null patch field where the SQL's COALESCE keeps it, read a null message differently, and worded the superseded message differently. Commit 15 aligns the fake with the SQL.
- Low, taken: the wrapped import in the manager's row types (commit 15).
- Low, noted: the state list is written out in two SQL CHECK constraints and one shared constant. SQL cannot read the constant, so a new state is three edits, and Postgres refuses a missed one at insert time.
- Low, noted: the five non-null assertions in the Postgres repository sit on rows the same transaction just locked or wrote.

The reviewer also checked the lock ordering, the partial unique index against begin's supersede then insert, the SQL parameter typing, the agreement of the row's state and reason with the operation row, the intent bump placement, the boot ordering and the ownership races named in the row, and found them sound. It saw an unrelated flake in `containerControl.test.ts` ("stops once the tail has arrived and nothing follows it") once in six runs, a file this branch does not touch.

Additional commits from the two reviews:

9. `792164d` fix: the rollout actions say why they are greyed out, and a stopped deployment offers neither
10. `7041db3` fix: the config file dialog's notice follows the live row rather than the view it opened on
11. `f12f27b` fix: the mock plays a failed recreate, and its reset clears whatever state the row carries
12. `8f6091c` test: a deploy hook that throws cannot relabel the deploy, a read that fails mid watch ends the rollout interrupted, and the superseded tick is held rather than raced. Three of the new tests fail on purpose.
13. `01ae490` fix: a deploy hook that throws keeps its failure to itself
14. `b5359ca` fix: a read or write that fails mid watch ends the rollout interrupted rather than watching forever
15. `3dbf660` test: the in-memory rollout table keeps a column a null patch field leaves, as the SQL does

Commands after commit 15: `cd manager && pnpm test` (519 pass), `pnpm typecheck` clean.

Checked in the browser after these, against the restarted mock: a file that says fail shows "The last config file could not be applied." with the manager's reason and Verify now. After a stop, Verify now is greyed out and its wrapper carries "Start the deployment first." After a start it is enabled again. The config file dialog opened during a verification said "Verifying: SRS 6 is watched for a while..." and, left open past the end of the watch, dropped the notice on its own when the rollout applied.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock (`mock-manager` plus the vite dev server), on backup-stage, which runs the main-v3 version, driven by script because the Browser pane was hidden.

- A file containing `interrupt` applied through the API: the card said "Recreating SRS 6 on the new config file." during the recreate, then "The rollout was interrupted by a manager restart." with the stored reason and the two buttons Verify now and Back to the previous file.
- Back to the previous file opened its confirm ("The file the interrupted rollout replaced is stored again and SRS 6 is recreated on it. The file that was being applied is no longer stored, so copy it first if you want to keep it."), then the card said "Recreating SRS 6 on the template." and afterwards showed no notice and no own-file note, because the previous file was the template.
- A file containing `crash`: "Verifying: SRS 6 is watched for a while on the new config file, and the previous one comes back if it does not stay up." then "The last config file was reverted." with the engine's last lines. The config editor dialog opened on that row led with the same heading and reason.
- A good file stopped mid watch through the API: "The last config file was not verified. Stopped by the operator before the file was verified." with Verify now. After a start, Verify now opened its confirm ("SRS 6 is recreated on the stored config file and watched for twenty seconds..."), then the card went through recreating and verifying and ended with no notice and the own-file note.

## Questions for Levi

- Migration 014 has never run against a database. It adds four columns with defaults, one table and two indexes, in one transaction like the others. The `instance_id` default is `gen_random_uuid()`, built into Postgres 13 and later, and the compose file runs postgres:16.
- On a stopped deployment both actions are greyed out with "Start the deployment first.", because taking either would start the deployment. The notice itself stays, so the operator sees why the file was not verified. Say if you would rather have the actions start the deployment from there.
- The engine card is also changed by T11 (`fix/t11-effective-settings`), so the second of the two to merge will conflict in `EngineCard.tsx`. Both changes are additive and resolve by keeping both.
- `manager/test/support/routerTestApp.ts` is the same file T19 adds, byte for byte, so either branch can merge first.
- The interrupted state's reason texts and the card copy are mine. Change any wording you like, the tests match on fragments.

## Not done here

- No test runs the Postgres repository. The service tests run against the in-memory table, which mirrors the conditional writes. The workflow in T20 with a Postgres service is where a database test would go.
- Nothing here touches the host, any deployment, or any credential.
