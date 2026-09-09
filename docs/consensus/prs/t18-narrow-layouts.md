# fix: keep version state and actions usable on narrow screens

Local branch `codex/t18-narrow-layouts` at `5f835ca2bf33266785e099bb28e1a0f203b6b3fa`. Not pushed or merged into main-v2. This branch merges T04a `6b360c6` and reviewed T08 completion `347c7dd`.

Version actions and Tested previously sat outside the visible table at narrow widths. Wrapping cards now keep each version's identity, state, default/tested labels and actions visible. Native keyboard disclosures hold contract details. Long references, build metadata and errors wrap within the card.

The cards send the shown build id and commit for Tested approval, refuse missing immutable identity and show the recorded approval-loss warning. Their help distinguishes immutable build approval from legacy commit approval. Default, Update and Remove interactions remain intact. No independent API policy was introduced by the layout change.

## Validation

- Actual browser viewports: 723×960, 390×960 and 1280×960. Each document remained within its viewport width. Every card's controls and visible text were measured.
- Enter expands contract details. Keyboard Tested submits the shown commit. Default and Remove require confirmation. A locally started build disables its actions and retains its failure log.
- 569 manager tests, 265 shared tests and 11 browser/transport tests passed. Workspace types and diff checks passed.
- Layout RED `0d76237`, GREEN `43b932b`. Protocol deadline/connection failure RED `d7c97f3`, GREEN `9187429`. Action coverage `dd8eef1`.
- T08 merge `e74ed67`, semantic RED `919116c`, GREEN `5f835ca`. The combined integration passed 21 browser/helper tests, 13 publication tests, workspace types and diff checks. Recorded warnings and all controls fit actual 390, 723 and 1280 widths. Evidence is under `.scratch/t18-visual-evidence/t08-integration/` in this worktree.
- Local evidence and commands: `/private/tmp/t18-codex/docs/testing/t18-narrow-layouts.md`. Final screenshots and measurements: `/private/tmp/t18-codex/.scratch/t18-visual-evidence/final/`.

The tests used isolated Chrome profiles and loopback fixtures. The original layout run had independent post-run confirmation that its process, profile and listeners were gone. The integration run's evidence is its successful awaited cleanup hooks and exit code 0. Its Chrome child/profile and Vite server cleanup completed, but no separate post-run PID or port check was made and no integration cleanup.json was written. No host, live service, real build or funds were used. No package or lockfile changed.

## Review and remaining integration

Cross-provider review, OpenAI-hosted. The lead reviewed the committed production changes, action tests, bounded harness cleanup and actual 390px, 723px and 1280px visual evidence. The harness deadline finding was corrected. No remaining finding blocks the T18 layout scope.

T08's immutable-build approval and D07 wizard behavior are now integrated. The lead inspected the final card changes, regression evidence and actual 390px and 723px warning screenshots. T08's eight real PostgreSQL regressions also pass at its reviewed `347c7dd` checkpoint, recorded in `/private/tmp/t08-sql-approval-r2.log`.

The inherited UI offers Update on a Building row loaded from GET because its busy flag comes from a build started on the current page. This is documented for a lifecycle follow-up. The browser tests distinguish the two cases. These screenshots cover Chromium viewports, not physical phone hardware.

The earlier 0.5 BZZ chequebook fill remains unverified.
