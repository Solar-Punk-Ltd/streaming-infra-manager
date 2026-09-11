# T08. Bind tested approval and default selection to a build

Source: R07. Priority: P2. Depends on: T04a for the build id (the first two parts do not). Decision: D07 decided. Size: S.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`markBuilt` clears `tested` on a new commit (PostgresStackVersionRepository.ts:114) but `setCommitSha`, used by the bundled refresh, does not (:151). The Tested PATCH (routes/versions.ts:74) carries no commit, so a stale click approves whatever SHA arrived after the page rendered. The wizard falls back to `choosable[0]` (wizardState.ts:117).

## Scope, in three parts

1. Ready first: `setCommitSha` applies the same `tested AND commit unchanged` rule `markBuilt` has, so a bundled refresh invalidates approval.
2. Ready first: the Tested call carries the commit the page showed, and the write itself is conditioned on that commit and on `status = ready`. An unknown commit is never approved as a known artifact.
3. After T04a: approval keys on `build_id`. The wizard drops the silent fallback. D07: a default that lost Tested stays the default with "not tested since the update on <date>" visible. With no default, an explicit choice is required.

## Acceptance

- Changing the SHA clears approval, bundled included. Rebuilding the identical approved artifact keeps valid approval.
- A stale Tested click racing a build start, and racing a bundled refresh, cannot approve the newer SHA.
- Default update and no silent fallback are covered through the wizard state.

## Where the design lives

PRD "**T08.**" in Fable round 1 section 5 and OpenAI round 2 section 4, "Same commit built again" in "##### Question 1, T04" (Fable round 3), decision D07.

## Code anchors

versions/PostgresStackVersionRepository.ts :104 to :123 and :151, api/routes/versions.ts:74, frontend forms/wizard/wizardState.ts :114 to :119.
