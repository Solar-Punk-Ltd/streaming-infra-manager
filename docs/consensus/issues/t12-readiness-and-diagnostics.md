# T12. Make readiness and diagnostics explain the current blocker

Source: UX03, UX04, UX05, UX10. Priority: P2. Depends on: T07 and T11 where their results are displayed. Decision: D02 decided. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`readiness.ts:80` puts the stamp before funding while `checklist.ts:72` puts funding first, so headline and checklist disagree. Node startup keeps promising completion within a minute (`useBeeUtils.ts:51`). The Publish card says stopped during DEPLOYING (`PublishCard.tsx:47`). Container logs are not reachable from the container row.

## Scope

- One first-blocker function shared with the checklist's order: funding before stamp before uploader. Headline, checklist and primary action agree.
- Node startup reads Bee's own status and shows what it says with an observation timestamp. Progress appears only when the running API supplies it, otherwise an honest initialising or unavailable state.
- A Logs action per row on the Containers card.
- Starting and restarting are distinguished. Deploying is never described as stopped. Old observations are identifiable while a new state is being established. Unknown, stale and unreachable stay separate from verified failure and verified readiness.
- Running containers do not by themselves establish receiving, uploading or playable.
- D02 wording for the refusal when the node does not answer. No automatic shutdown of existing streams. Chequebook settlement wording follows T09.

## Where the design lives

PRD "**T12.**" in Fable round 1 section 5 and OpenAI round 2 section 4, decision D02.

## Code anchors

frontend deployments/readiness.ts :64 to :105, checklist.ts :70 to :83, readySummary.ts, PublishCard.tsx :47 to :51, ContainersCard.tsx :83 to :94, uploaders/useBeeUtils.ts:51.
