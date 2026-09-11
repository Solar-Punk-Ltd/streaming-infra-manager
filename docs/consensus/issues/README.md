# Issue files for the main-v2 remediation set

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

One file per row of the final task table (PRD, "### Fable round 6", "#### 3. Exact task set, final from Fable's side"). Each file is short on purpose: it names the scope, the accepted design by PRD heading, the acceptance tests both reviewers agreed, the code anchors at d046ebf, and what it waits for. Read the PRD heading before implementing a row, and do not redesign what is there.

## Order

Ready first, no dependency and no open decision: T01a, T02, T10, T13, T19, T11, T16, T17, the two independent parts of T08.

Then by dependency: T01 (after T01a), T03 (after T01), T04a, T04b (after T04a), T05a, T05b (Levi's stack commits, D09), T06 (after T04a), T07, T08 rest (after T04a), T09 (after T10), T12 (after T07 and T11), T14 (after T09, D04 numbers), T15 (after T12), T18 (after T04a and T08), T20 (after T10), T21 (after the tasks it documents), T22 (after T10 and the fixes, D05 numbers).

## Working rules

- One branch per row off main-v2, one fix per commit, tests before code. No Co-Authored-By, no em-dashes or semicolons in prose or UI copy.
- Nothing is pushed and no PR or issue is opened without Levi's word for that item. PR bodies are drafted locally and handed over.
- No host operations, no deploys, no paid actions. The deployment review-20260907 (slot 4, main-v3) is funded and not disposable. Its 0.5 BZZ chequebook fill has no transaction evidence yet and is never called unsent, settled or safe to retry.
- Never `docker compose config` without `--quiet`, never kill processes by pattern, never print or write a credential.
- Tests: `cd manager && pnpm test` (491 at baseline), `cd common && pnpm test` (261), `pnpm -r typecheck` at the root after `pnpm --filter @streaming-infra-manager/common build`.

## Still owed by Levi

- D04 numbers for T14: preset capacities and lifetimes, and the spending ceiling.
- D05 numbers for T22: spending cap, duration, what to publish, and what happens to the node's funds after the test.

## Decisions taken (PRD "### Decisions taken by Levi, 2026-09-07")

D01 cap min(version maximum, 100) counting stopped records. D02 refuse a new uploader start when its node does not answer. D03 generate a passphrase when the host has none, host default kept, expert unencrypted kept. D04 quote first, no preselected spend, ceiling enforced. D05 review node kept and reused. D06 CI checks required on main-v2, Levi's bypass, agents never push. D07 a default that loses Tested stays default with a warning. D08 no historical build catalogue. D09 image-name fix on main-v3 plus bundled bump, Levi's commits. D10 assertion override behind a typed confirmation.
