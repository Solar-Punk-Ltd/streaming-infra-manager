# T08 remaining work, 2026-09-08

## Current reviewed checkpoint

Verification update: Levi explicitly approved local edits/commits and disposable test databases. All eight PostgreSQL regressions passed at unchanged `347c7dd`, with zero failures or skips, in `/private/tmp/t08-sql-approval-r2.log`. The database contained only synthetic schemas. Exact container `c07a7b5061811a81c3b508a20408bbe514842d2f8286db2ab8782c04659fdc8e` was stopped and its removal verified after automatic cleanup completed. The former SQL permission gap is closed. Earlier pending statements below retain the original review timeline.

T08 completion is implemented on the existing branch, clean at `347c7dd61cc26c00f9f41af00da50455b0d3c8fd`. T04a is merged. The lead reviewed the completion from `/private/tmp/t08-review-codex`, including atomic approval predicates, invalidation history, prepared SQL races and browser evidence. SQL execution remains pending explicit local database approval. The earlier preparation text below is historical.

- Build identity RED `3b0ebc2`, GREEN `677bf83`. Immutable approval names the shown non-null build id and commit, conditional on layout and Ready status. Explicit legacy rows retain commit approval only while their build id stays null.
- Invalidation history RED `36e07cb`, GREEN `bdf90ae`. Migration022 records the first actual update that removed approval. Reapproval and manual withdrawal clear it. Further unapproved updates preserve it. No date is backfilled.
- Wizard/browser RED `0c91a76` and `8060305`, GREEN `74c8efc`. No default means explicit choice. An untested default remains selected with its actual date in Basics and Review. Missing immutable identity disables approval. Withdrawal uses accurate current-state wording.
- Lead review found a late-response dead end. RED `3fa1702`, GREEN `347c7dd` keeps the selector visible whenever no valid selected version exists. The browser covers a delayed sole default, a new default preserving explicit choice, removed selection and retained draft fields.
- At `7f45b3c`, 574 manager tests, 265 shared tests, 9 browser/helper tests and workspace types passed. The final small selector correction passes 10 browser/helper tests and frontend types. Logs are `/private/tmp/t08-manager-full.log`, `/private/tmp/t08-common-full.log`, `/private/tmp/t08-late-default-green.log`, `/private/tmp/t08-final-types.log` and `/private/tmp/t08-final-sql-test-types.log`.
- Eight real PostgreSQL regressions are committed, including actual row-lock waiting and publication between service read and write. They are written and typechecked but unexecuted. Automatic approval review rejected the local container launch. No bypass or retry without permission is authorized.

T18 integration is complete and lead-reviewed in `/private/tmp/t18-codex` at `5f835ca`, carrying the final approval identity and warning into VersionCard. T08 itself is handed off with SQL verification pending. T15's dependency merge of this checkpoint remains paused for the explicit local-write override. No remediation was merged into main-v2 or pushed.

## Historical preparation

The first two parts are committed on `fix/t08-tested-approval` at `b9a2334`. The lead prepared `/private/tmp/t08-codex` on that existing branch, clean at that commit, with independent copies of the already installed dependencies. No merge or implementation has started there. Do not create another task branch for the same row.

Read `issues/t08-tested-approval.md`, D07 in PRD.md, `prs/t08-tested-approval.md`, and `ACCEPTANCE-AUDIT.md`. The existing draft explicitly leaves the third part open. The lead owns the shared documents and PR draft.

## Required work

1. Merge T04a `6b360c6` locally with a normal merge commit. Keep both the immutable build behavior and the commit-bound approval tests. Resolve only mechanical overlaps and preserve history.
2. Propose the approval request and atomic repository condition before implementing. For immutable builds, approval must name the build id shown to the user. A stale page cannot approve a different build of the same commit. Address legacy rows explicitly using the recorded compatibility behavior. Do not invent a new policy or silently pretend a null build id is a known immutable artifact.
3. Remove the wizard's fallback to the first selectable version. With no default and no explicit selection, the user must choose. An explicit valid choice survives navigation. A selected default that loses Tested remains the default, with the agreed update warning and date.
4. Keep tests first and one logical fix per commit. Exercise approval publication races against an actual isolated PostgreSQL database. Include same commit with different build ids, unchanged build id, a stale click while building, null identity, approval withdrawal, and a competing publish between service read and conditional write. Use offline browser tests for wizard selection and visible D07 copy.
5. Run focused tests, relevant full checks and types. Return a clean committed checkpoint, evidence paths, remaining acceptance and a proposed replacement PR body. Do not edit shared documents or mark the entire row approved yourself.

## Integration

T18 has already merged the first two T08 parts and T04a. Its layout uses a separate VersionCard component. Carry the final approval payload and warning semantics into that layout after the T08 review. Avoid mixing responsive layout changes into T08.

The lead separately recorded a T04a stale-read/pruning review point in ACCEPTANCE-AUDIT.md. Do not absorb that fix into T08 or call it resolved through approval tests.

No push, GitHub write, main-v2 merge, host access, deployment, live Bee/RPC or funds. Use cached local test images with no pull, unique loopback resources and exact cleanup only. Never inspect live credential values.
