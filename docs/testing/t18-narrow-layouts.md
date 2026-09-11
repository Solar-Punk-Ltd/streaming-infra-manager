# T18 narrow layouts

Cross-provider review, OpenAI-hosted.

The Versions page now presents each version as a card. Its name, state, default label, tested control and actions stay visible at narrow widths. Build metadata wraps within the card. Contract detail opens through a native keyboard-accessible disclosure. The cards require no horizontal scrolling.

**Status, 2026-09-10.** This work is on the branch `feat/ai-remediation`, at commit `6dc33d1`, which is pull request #40 into `main-v2`. The card gained a fifth control since the run recorded below: **Settings**, which opens that version's own configuration files. `frontend/test/versions-layout.test.mjs` now asserts five controls per row, and the same everything-fits property at 723, 390 and 1280 pixels. That file runs through `pnpm --filter @streaming-infra-manager/frontend-prototype test:browser` with the other browser suites, described in [../ci.md](../ci.md). Everything dated below is the checkpoint it says it is.

## Scope and dependencies

This implements the T18 acceptance criteria recorded in the main-v2 consensus. The branch starts at `d046ebf` and merges `fix/t04a-immutable-builds` at `6b360c6` and `fix/t08-tested-approval` at `b9a2334`. These merges retain their history. Nothing is merged into main-v2.

The reviewed T08 completion at `347c7dd` was merged locally in `e74ed67`. Tested now sends both the shown build id and commit. The cards carry T08's missing-build guard, accurate approval help and recorded invalidation warning. Default, Update, Remove and keyboard disclosure behavior remain unchanged.

## Tests first

| Guarantee | RED evidence | GREEN evidence |
| --- | --- | --- |
| Identity, labels and all three actions fit actual 723px and 390px viewports, including long names, branch references and errors | `0d76237` reproduced the original table controls over 5,000px from the left edge | `43b932b` replaces the table with wrapping cards. The final browser suite also checks every visible text rectangle. |
| Contract detail expands with the keyboard | The same RED run found no disclosure elements | Enter opens the native disclosure at 390px. The page remains within its viewport. |
| Browser protocol requests cannot hang after silence, close or error | `d7c97f3` references the missing bounded client | `9187429` adds request deadlines, connection-end rejection and bounded cleanup of the owned Chrome child. Three transport tests pass. |
| The presentation retains the existing operations | Additional behavior regressions in `dd8eef1` | Tested sends the shown commit. Default and Remove require confirmation. A locally started build disables its actions and keeps its failed log. Existing approval can be withdrawn while the server reports Building. |

The original layout test measured MUI's intentionally oversized transparent switch input. The final test measures the visible label or switch track instead. It still detects the original offscreen control failure. Keyboard dispatch also waits for the browser's native disclosure update.

One dependency merge required a test adaptation. T04a's publication test called `setTested(id, true)` before T08 required a shown commit. Commit `368c0a1` supplies the fixture's `COMMIT_A`. Its 13 publication tests pass. No production approval rule was changed for that adaptation.

## Validation on 2026-09-08

| Check | Result |
| --- | --- |
| `node --test frontend/test/versions-layout.test.mjs frontend/test/support/chrome-protocol.test.mjs` | 11 tests pass, including the parent browser test, seven browser scenarios and three transport cases. Both files now also run through the browser runner, which is how the checks workflow takes them. |
| Manager unit suite, `DATABASE_URL=postgres://unused node --import tsx --conditions=development --test --test-concurrency=2 test/unit/**/*.test.ts` | 569 pass |
| Shared suite, `node --import tsx --test src/**/*.test.ts` from common | 265 pass |
| `pnpm -r typecheck` | Pass |
| `git diff --check` | Pass |

The first manager run lacked loopback binding permission and hit `EPERM` in HTTP tests. The authorized local rerun passed after the dependency test adaptation above.

The browser suite uses the installed Chrome binary and Vite. It starts its own Chrome profile and loopback-only fixture. It blocks browser page requests to other origins. It does not start the manager, Docker, a build script or any live service. The HTTP writes in the test are in-memory fixture calls only. No dependencies or lockfiles changed.

To run on another machine, set `CHROME_BIN` to its installed Chrome or Chromium executable. Set `T18_EVIDENCE_DIR` to a local directory to retain screenshots and measured viewport dimensions. No browser download is performed.

## Visual evidence

The final run used Chrome `152.0.7977.83`.

| Requested width | Actual `innerWidth` | Actual `innerHeight` | Document width |
| --- | --- | --- | --- |
| 723 | 723 | 960 | 723 |
| 390 | 390 | 960 | 390 |
| 1280 | 1280 | 960 | 1280 |

Local evidence is under `.scratch/main-v2-review-consensus/evidence/t18-visual-evidence/final/`, where it was collected when the T18 worktree was folded in. It contains `versions-723.png`, `versions-390.png`, `versions-1280.png`, `versions-390-expanded.png`, `viewport-measurements.json` and `cleanup.json`. RED and intermediate screenshots are in the adjacent directories. Screenshots were visually inspected as well as measured.

The recorded final Chrome PID was `47797`, its debug port was `51956`, and the fixture port was `5173`. The suite terminates only its own child. A subsequent check confirmed that the child was gone, its temporary profile was removed and both listeners were closed. The shared control-room ports were never used.

## Remaining observations and limits

- The inherited UI still allows Update on a Building row loaded from `GET /versions` because its busy flag comes from builds started on this page. T18 preserves that lifecycle behavior and makes it visible. The browser tests distinguish the loaded Building fixture from a locally started build. A follow-up should connect action availability to the authoritative build state.
- T08's real PostgreSQL race suite was unexecuted when this section was written. It runs now, with the rest of `manager/test/database/`, through `pnpm test:database` against nine disposable databases. The browser integration still does not stand in for it.
- These are actual browser viewports, not a physical phone or touch-device test. Only the installed Chromium engine was exercised.
- The suite checks rendering, clipping, keyboard behavior and API calls. It does not collect statement coverage or run a separate accessibility scanner.
- No host, deployment, funded node, live RPC or chain transaction was touched. The earlier 0.5 BZZ chequebook fill remains unverified.

## T08 completion integrated on 2026-09-08

Card integration RED `919116c` reproduced the missing dated warning, enabled approval with no immutable build id and obsolete commit-only help. The fix reuses `lostApprovalWarning` and carries the reviewed guard and copy into `VersionCard`.

The combined offline card, wizard and protocol suite passes 21 tests. It checks the shown build payload, default confirmation, withdrawal, legacy eligibility, delayed version loading and a removed explicit choice. The 13 publication tests pass after the dependency merge. Workspace types and diff checks pass. No additional backend behavior was changed here.

The warning and all four card controls of the day fit below the sticky header at actual widths 390, 723 and 1280, each with height 960. There are five now, and the same property is asserted for all five. Its date stays distinct from the later build date. Long metadata and errors still wrap. Contract disclosure, default confirmation, Remove and locally started build behavior remain covered. The three warning screenshots were visually inspected.

Integration evidence is in `.scratch/main-v2-review-consensus/evidence/t18-visual-evidence/t08-integration/`. `cards/` contains the viewport measurements and `versions-<width>-approval-warning.png` screenshots. `wizard/` contains the review warning screenshot. The three execution logs, `t18-t08-browser-green.log`, `t18-t08-publication-green.log` and `t18-t08-final-types.log`, were written under `/private/tmp` at the time and now live in `.scratch/main-v2-review-consensus/evidence/private-tmp/` under those same names.
