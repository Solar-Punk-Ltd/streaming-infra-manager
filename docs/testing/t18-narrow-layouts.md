# T18 narrow layouts

Cross-provider review, OpenAI-hosted.

The Versions page now presents each version as a card. Its name, state, default label, tested control and actions stay visible at narrow widths. Build metadata wraps within the card. Contract detail opens through a native keyboard-accessible disclosure. The cards require no horizontal scrolling.

## Scope and dependencies

This implements the T18 acceptance criteria recorded in the main-v2 consensus. The branch starts at `d046ebf` and merges `fix/t04a-immutable-builds` at `6b360c6` and `fix/t08-tested-approval` at `b9a2334`. These merges retain their history. Nothing is merged into main-v2.

T18 changes presentation and preserves the existing version operations. T08 is still partial. Approval keyed to an immutable build id and the D07 wizard default behavior remain separate T08 work. The present Tested request continues to send the commit shown on the page.

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
| `node --test frontend/test/versions-layout.test.mjs frontend/test/support/chrome-protocol.test.mjs` | 11 tests pass, including the parent browser test, seven browser scenarios and three transport cases |
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

Local evidence is under `.scratch/t18-visual-evidence/final/` in the T18 worktree. It contains `versions-723.png`, `versions-390.png`, `versions-1280.png`, `versions-390-expanded.png`, `viewport-measurements.json` and `cleanup.json`. RED and intermediate screenshots are in the adjacent directories. Screenshots were visually inspected as well as measured.

The recorded final Chrome PID was `47797`, its debug port was `51956`, and the fixture port was `5173`. The suite terminates only its own child. A subsequent check confirmed that the child was gone, its temporary profile was removed and both listeners were closed. The shared control-room ports were never used.

## Remaining observations and limits

- The inherited UI still allows Update on a Building row loaded from `GET /versions` because its busy flag comes from builds started on this page. T18 preserves that lifecycle behavior and makes it visible. The browser tests distinguish the loaded Building fixture from a locally started build. A follow-up should connect action availability to the authoritative build state.
- T08's immutable-build approval and D07 default selection work remain open. A card displaying Tested is not evidence that those remaining approval rules are implemented.
- These are actual browser viewports, not a physical phone or touch-device test. Only the installed Chromium engine was exercised.
- The suite checks rendering, clipping, keyboard behavior and API calls. It does not collect statement coverage or run a separate accessibility scanner.
- No host, deployment, funded node, live RPC or chain transaction was touched. The earlier 0.5 BZZ chequebook fill remains unverified.
