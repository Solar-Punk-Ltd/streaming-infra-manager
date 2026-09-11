# T09 completion brief: receipt polling, a portable harness, connected acceptance

Written by Fable on 2026-09-10 for the Opus implementation session. Baseline: `feat/ai-remediation` at 64563da. Task branch: `feat/t09-receipt-polling`, cut from that head. The PR is #40 into `main-v2`.

## What T09 is, and what is still missing

T09 makes every BZZ move between a deployment's Bee node and its chequebook a durable operation with a transaction identity. The journal, the one-open-operation-per-node rule, the receipt check by hash, the recovery of a lost response, the manual hash resolution and the D10 assertion are all merged. Read `docs/consensus/issues/t09-money-by-transaction.md` for the accepted design and `docs/features/chequebook.md` for how the merged code behaves.

Three things are still open, named by the handover in `docs/handover/main-v2-remediation.md` under "The next work", item 3:

1. **The manager never polls a receipt on its own.** After Bee answers with a hash the row sits in `submitted` until somebody presses Check on the transfer page. The accepted design says the receipt is "polled a few times a minute for a bounded time" (PRD, Fable round 2, T09). Without it the node stays locked and the outcome stays unread whenever nobody is watching the page.
2. **The intent browser suite assumes a server nobody starts.** `frontend/test/transfer-intent-browser.test.mjs` hard-codes `http://127.0.0.1:54291`. Every other browser suite starts its own Vite on a free port and stops it. This one cannot run on a runner.
3. **Nothing exercises the real composition end to end.** The SQL suite drives the real repository with fakes for the chain and the Bee session, the factory test drives the owned transport with an in-memory journal, the browser suites drive the UI against a Node mock. No test signs in, submits through the real router into the real Postgres journal over the owned Docker transport against a synthetic Bee, and reads the outcome back through the UI.

Everything else is out of scope: real SSH, the qualification of a real Bee image (the production catalog `PRODUCTION_BEE_BRIDGE_QUALIFICATIONS` stays empty, a synthetic pass qualifies nothing), a real RPC endpoint, funds, and T14.

## Part 1. Bounded receipt polling

### The rule

An operation that enters `submitted` gets one polling budget, set when it enters that state and never renewed. While the budget lasts, the manager checks the receipt about every 20 seconds. A terminal receipt (`settled` or `reverted`) ends polling by changing the state. The budget's end leaves the row in `submitted` with its last observation, and the operator's Check still works as before. Nothing the operator does, and no restart, extends a budget. A row that is `submitting` or `unknown` is never polled, never scanned, never resubmitted by the poller: recovery stays the operator's explicit action. A row with `failureReason === 'hash_conflict'` is never polled either, the existing `ChequebookReceiptCheck.check` already returns early on it.

Constants, exported from `common/src/chequebookOperations.ts` so the manager and the page say the same numbers:

```ts
export const RECEIPT_POLL_BUDGET_MS = 30 * 60_000;
export const RECEIPT_POLL_INTERVAL_MS = 20_000;
export const RECEIPT_READ_INTERVAL_MS = 10_000;
```

The third one is the page's re-read cadence, see Part 2.

### The row

Migration `manager/src/migrations/031_receipt_polling.sql`: `ALTER TABLE chequebook_operations ADD COLUMN receipt_poll_until TIMESTAMPTZ`, with `CHECK (receipt_poll_until IS NULL OR transaction_hash IS NOT NULL)`. Historical rows keep NULL and are never polled, which is the no-renewal rule applied to the past.

`ChequebookOperation` in common gains `readonly receiptPollUntil: string | null`. It is part of the record, like `receiptCheckedAt`, so the history page and the detail page read it from the same JSON. Grep for `receiptCheckedAt` across `common`, `manager` and `frontend` (source, tests, fixtures, `frontend/dev/mock-chequebook*.mjs`, `frontend/test/support`, `frontend/test/*.mjs`) and add the field everywhere an operation is built by hand. The frontend's `isTransferOperation` in `frontend/src/transfers/transferEvidence.ts` accepts `null` or an ISO timestamp for it, nothing else.

`PostgresChequebookOperationRepository` sets `receipt_poll_until = NOW() + <budget>` in every statement that moves a row into `submitted`, and only there: `recordSubmission` with a `submitted` outcome, `recordRecovery` when a unique candidate is adopted, `resolveCandidate`. Read each of those three writes before touching them, their `WHERE` clauses are the concurrency contract the SQL suite pins. The budget is a constructor option `{ receiptPollBudgetMs?: number }` defaulting to `RECEIPT_POLL_BUDGET_MS`, so the connected test can use a short one. `InMemoryChequebookOperations` in `manager/test/support/chequebookOperations.ts` mirrors the rule with the same option. `SyntheticTargetChequebookRepository` inherits it.

New repository method:

```ts
/** Rows the poller owes a check: submitted, hash known, unconflicted, budget not spent, last check older than one interval. */
listAwaitingReceipt(input: { intervalMs: number; limit: number }): Promise<readonly ChequebookOperation[]>;
```

Postgres: `state = 'submitted' AND transaction_hash IS NOT NULL AND failure_reason IS DISTINCT FROM 'hash_conflict' AND receipt_poll_until > NOW() AND (receipt_checked_at IS NULL OR receipt_checked_at <= NOW() - make_interval(secs => $1 / 1000.0)) ORDER BY receipt_checked_at NULLS FIRST, created_at LIMIT $2`. The in-memory fake uses `Date.now()`.

### The poller

`manager/src/domain/chequebook/ChequebookReceiptPoller.ts`:

```ts
export class ChequebookReceiptPoller {
  constructor(repository: Pick<ChequebookOperationRepository, 'listAwaitingReceipt'>,
    receipts: Pick<ChequebookReceiptCheck, 'check'>,
    options?: { intervalMs?: number; batchLimit?: number; log?: (line: string) => void });
  start(): void;
  /** Resolves once no tick is scheduled and no batch is running. Safe to call twice. */
  stop(): Promise<void>;
}
```

One batch at a time. A tick lists the due rows, checks each one in turn through `ChequebookReceiptCheck.check` (that class already turns an inspector failure into `could_not_check` and journals it, and the receipt write is a compare-and-set on the revision, so a concurrent manual Check cannot double-write), and schedules the next tick `intervalMs` after the batch ends, never from its start, so batches cannot overlap. A thrown journal error for one row is caught, counted, and the batch continues. One log line per tick at most, and only when something changed or failed: the operation ids and the observation kinds, never an endpoint, never a stack of driver text. When a row's state leaves `submitted` the line says so, when a budget ends without a terminal receipt the poller cannot tell (the row simply stops being listed), so the page carries that message instead, see Part 2. `start()` runs the first batch at once, which is how a restart resumes rows whose budget has not passed. Default `batchLimit` 20.

Wire it in `createChequebookOperationsService`: build the poller from the repository and the existing `ChequebookReceiptCheck`, give `ChequebookOperationsService` a `start()` that starts it and make `shutdown()` stop it before closing the transports. In `manager/src/index.ts` call `chequebookOperations.start()` right after the service is created. The existing shutdown path already awaits `chequebookOperations.shutdown()`.

### Tests, before the code

- `manager/test/unit/chequebookReceiptPoller.test.ts`, with the in-memory repository, a scripted `check` and an injected scheduler so no test waits on real time: a submitted row within budget is checked on start and again after one interval, a `settled` answer ends its polling, a row past its budget is never listed, a `submitting` row and an `unknown` row are never checked, a `hash_conflict` row is never checked, a thrown journal error on one row does not stop the others in the batch and does not stop the next tick, batches never overlap when a check outlives the interval, `stop()` waits for the running batch and schedules nothing more, `start()` after `stop()` is refused or idempotent (choose one and test it), the log line names ids and kinds only.
- `manager/test/unit/chequebookOperations` shape tests and `common/src/chequebook*.test.ts`: `receiptPollUntil` round-trips and the constants are exported.
- `manager/test/database/chequebookOperations.test.ts`: `receipt_poll_until` is set by `recordSubmission`, by candidate adoption in `recordRecovery`, by `resolveCandidate`, and by nothing else (a receipt check, a manual check, a second `recordSubmission` on a conflicted row, an assertion leave it unchanged), `listAwaitingReceipt` lists exactly the due rows and respects the interval and the limit, the migration leaves historical rows at NULL, a second repository instance (a restarted manager) lists the same due row and the compare-and-set lets only one of two concurrent checks record.

## Part 2. The page follows the poller

The transfer detail page (`frontend/src/transfers/TransferDetailPage.tsx`) and the Move BZZ dialog (`frontend/src/uploaders/MoveBzzDialog.tsx` through `useTransferController`) both show a `submitted` operation the operator is waiting on. Today they re-read only on a click, on focus or on visibility. While the shown operation is `submitted` and its `receiptPollUntil` is in the future, they re-read it every `RECEIPT_READ_INTERVAL_MS`, and stop when the state changes, when the deadline passes, or when the component goes away. This is a read of the saved record, `GET /chequebook/operations/:id` or the by-request lookup, never a `check` call: the manager is doing the checking. The detail page gets the cadence through an option on `useTransferRead`, the dialog through an effect in `useTransferController` that calls `controller.restore()` (confirm that repeated `restore()` calls are serialised by the controller's active-task guard before relying on it).

Two sentences, plain, on both surfaces, using the shared constants for the numbers:

- While polling: "The manager checks the chain for this transaction's receipt about every 20 seconds until 14:32. This page re-reads the saved record every 10 seconds meanwhile."
- After the deadline, state still `submitted`: "Automatic checks ended at 14:32 without a final receipt. Use Check to ask the chain again."

Times are shown in the operator's local time. No countdown, no spinner that never ends.

The mock journal `frontend/dev/mock-chequebook.mjs` behaves like the server so `pnpm dev:mock` shows the flow: a submitted operation carries `receiptPollUntil`, and unless a test supplies `receiptFor`, the mock settles it on its own a few seconds after submission. The dev mock on port 9876 is somebody else's process if it is running, never touch it, test your change with your own instance.

Tests, before the code: a browser case (new file `frontend/test/transfer-polling-browser.test.mjs`, owned Vite and API through `launchTransferFixture`) where the fixture answers `submitted` on the first reads and `settled` later, and both the dialog and the detail page show `settled` without a click within the bound, with the GET count proving the re-reads happened and the `check` count staying zero. A second case with `receiptPollUntil` already past: the "ended" sentence is shown, no re-read happens (GET count stays at one), Check still works. `frontend/src/transfers/*.test.ts` for the pure pieces (the deadline arithmetic, the sentence builder).

## Part 3. The intent harness owns its server

`frontend/test/transfer-intent-browser.test.mjs`: drop the constant origin, start the fixture the way `transfer-history-browser.test.mjs` does, `launchTransferFixture(t, (_req, res) => json(res, 404, {}))`, and pass `fixture.origin` to `launchChrome` and to `anotherTab`. Nothing in that file may read a port from the environment or assume a listener. Update the two sentences in `docs/testing/t09-browser-intents.md` that describe the 54291 listener (lines 21 and 31 at 64563da). Run the file alone and confirm it passes with no server started by hand.

## Part 4. Connected acceptance through the API

`manager/test/database/chequebookConnected.test.ts`, gated on `T09_TEST_PG_PORT` and `t09_test` like its neighbour, a random schema per test, migrations applied from `src/migrations`.

The composition is the production one: `createChequebookOperationsService(pool, runtime, dependencies)` where `runtime.dockerTransports` names one alias with a `unix` locator whose `socketPath` is a temporary socket served by `syntheticDockerBee` from `manager/test/support/syntheticDockerBee.ts` (see `manager/test/integration/localDockerUnix.test.ts` for the socket plumbing and `manager/test/unit/ownedChequebookFactory.test.ts` for the runtime JSON), `dependencies.qualificationCatalog` is `[qualifiedBridge()]`, `dependencies.createChainReader` is a scripted synthetic chain, the repository is the real Postgres one over a seeded synthetic target (`seedSyntheticChequebookTarget`, `SyntheticTargetChequebookRepository`), and the poller runs with `intervalMs` around 50 and a budget of a few hundred milliseconds where a case needs it to end. The HTTP side is the real gate: `requireSameSite`, `createRequireSession` over the in-memory auth of `manager/test/support/authTestApp.ts`, `createChequebookRouter`, `errorHandler`. The existing case "refuses HTTP submission after a held terminal GET predates a durable conflict" in `chequebookOperations.test.ts` shows how that app is put together in this suite.

Cases, each signed in through `POST /auth/login` with a fixture user and sending the write header:

1. Deposit accepted: 202 with `submitted` and the synthetic hash, the synthetic Bee counted one POST, the chain answers a success receipt with a canonical finalized history, and within the bound the poller moves the row to `settled` with no `check` request ever made, after which a new intent on the same node is admitted.
2. Receipt reverted: the same, ending in `reverted`.
3. Lost response: the synthetic Bee drops the response, the row is `unknown`, the poller never inspects it (the chain reader counts zero receipt reads for it), Check runs recovery, the row stays `unknown` when the scripted pending list and scan find nothing, and a second intent on that node answers 409 busy.
4. RPC outage while polling: the chain reader throws, the row stays `submitted` with `could_not_check`, polling continues across the outage, the receipt lands once the reader answers.
5. Budget spent: a short budget passes with the chain still pending, the row stays `submitted`, `listAwaitingReceipt` no longer names it, `receiptPollUntil` is in the past, a manual Check still runs the inspector once, and that Check does not put the row back on the poller's list.
6. Restart: a second service instance on the same pool, started while the budget lasts, resumes polling the same row, and after the budget it does not.
7. Replay: the same request id submitted again answers `replayed` and the synthetic Bee still counts one POST.

Every case asserts what the synthetic Bee and the synthetic chain were asked, not only what the row says. The suite stops the poller, the service, the socket server and the pool in `t.after`, and leaves no temporary directory behind (assert its removal the way `localDockerUnix.test.ts` does).

## Part 5. Connected acceptance through the browser

`frontend/test/transfer-connected-browser.test.mjs`, skipped visibly with a message naming `T09_TEST_PG_PORT` when it is unset (a `t.skip`, never a silent pass), Chrome required as in the other suites.

The server is `manager/test/support/connectedChequebookServer.ts`, a process the test forks with `tsx --conditions=development`. It boots the Part 4 composition on `127.0.0.1:0` with a random schema, reports `{ port }` over IPC, and takes IPC messages that script the synthetic parts: answer the next receipt as success or reverted, drop the next Bee response, report the Bee POST count and the chain read count. It exits when the parent disconnects and cleans its schema and socket directory. It also serves the little the UI needs around the money routes: the real `/auth` router over in-memory users (one fixture user with a synthetic password that is a test constant, printed nowhere), a stub `GET /profiles/:name` answering the synthetic profile the dialog harness already uses (`initialProfile` in `frontend/test/transfer-dialog-browser.test.mjs`), a stub chequebook summary with synthetic balances, and whatever `dev/t09-dialog-tests.html` and the transfers pages fetch on load. Stubs are marked as stubs in the file, and there are no stubs for anything under `/chequebook/operations` or the deposit and withdraw routes: those are the real router.

Vite comes from a variant of `launchTransferFixture` that takes an existing manager URL instead of creating its own API server. Refactor `frontend/test/support/transfer-fixture.mjs` so both paths share the Vite lifecycle code.

Three cases:

1. Sign in through the real login route, open `dev/t09-dialog-tests.html`, move 0.5 BZZ, confirm, see `submitted`, then see `settled` without a click after the fixture is told to answer a success receipt. The fixture reports one Bee POST.
2. Drop the next response: the dialog shows the unknown outcome with the recovery actions, the fixture reports zero chain receipt reads for it, Check leaves it unresolved, and a second move is refused with the busy explanation.
3. The transfers history page lists both operations, and the detail page of the first shows the receipt evidence, `receiptPollUntil`, and the "checks the chain" or "ended" sentence as appropriate.

Screenshots go to `RUNNER_TEMP` or the OS temporary directory the way the dialog suite does.

## Part 6. Docs and handover

- `docs/features/chequebook.md`: the states table and the "Checking and resolving" section say that a submitted operation is polled by the manager for the budget, that the budget is never renewed, that the page re-reads meanwhile, and that Check remains the operator's action afterwards. The sentence in the opening paragraph listing "finite receipt polling" among the remaining work goes.
- `docs/testing/t09-money-api.md`: the new field, the constants, the poller, the connected suite and how to run it.
- `docs/testing/t09-browser-intents.md`: the harness owns its server, the new polling and connected suites.
- `manager/README.md`: one paragraph under the chequebook floor naming `CHEQUEBOOK_RPC_ENDPOINTS` and `CHEQUEBOOK_DOCKER_TRANSPORTS` with a pointer to `docs/testing/t09-money-api.md`, since today the README documents the floor only.
- `docs/handover/main-v2-remediation.md`: a new dated section for this slice in the style of the existing ones, and the T09 row of the roadmap table updated. Say plainly what remains after this slice: real SSH and real image qualification, the production catalog still empty, T14 waiting on D04.

## How to work

- Read first: `docs/consensus/issues/t09-money-by-transaction.md`, `docs/features/chequebook.md`, `docs/testing/t09-money-api.md`, `manager/src/domain/chequebook/ChequebookReceiptCheck.ts`, `ChequebookRecovery.ts`, `ChequebookOperationsService.ts`, `createChequebookOperationsService.ts`, `PostgresChequebookOperationRepository.ts`, `manager/test/database/chequebookOperations.test.ts`, `manager/test/unit/ownedChequebookFactory.test.ts`, `manager/test/integration/localDockerUnix.test.ts`, `frontend/test/support/transfer-fixture.mjs`, `frontend/test/transfer-dialog-browser.test.mjs`.
- Tests first, RED then GREEN, one fix per commit, `test:` and `fix:` and `feat:` and `docs:` prefixes as the repository uses them. Add files by path, never `git add -A`, and never add anything under `.scratch/`.
- No em-dashes and no semicolons in prose, docs, comments or UI text. Semicolons in code are syntax and fine.
- Comments only where the code cannot say it. Names carry meaning. Shared shapes live in `common`.
- Manager unit run: `cd manager && DATABASE_URL='postgres://unused@localhost/unused' ./node_modules/.bin/tsx --conditions=development --test 'test/unit/**/*.test.ts'`. Gate on `# fail 0` in the summary, never on grep not finding `not ok`.
- SQL suites need a disposable Postgres: `docker run --rm -d --name t09-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55436:5432 postgres:16-alpine`, then `docker exec t09-pg psql -U postgres -c 'CREATE DATABASE t09_test'`, `export T09_TEST_PG_PORT=55436`, and run the file with `DATABASE_URL=postgres://postgres@127.0.0.1:55436/t09_test`. A file whose variable is unset skips silently, so check the summary says `# skipped 0`. Stop the container by its name when done. Never stop or kill anything by pattern.
- Browser suites run one file at a time from the repository root: `node --test frontend/test/<name>.test.mjs`, Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or `CHROME_BIN`.
- Before handing over: manager unit, common, frontend unit, every T09 SQL file with the container, the touched browser suites, all typechecks (`pnpm -r typecheck` after `pnpm --filter @streaming-infra-manager/common build`), `git diff --check`, and a grep of the changed docs and UI strings for em-dashes and semicolons.
- Never read `manager/.env` or any credential. Never touch the host 157.90.34.105, never push, never open anything on GitHub. The reviewer and the merge are Fable's.
