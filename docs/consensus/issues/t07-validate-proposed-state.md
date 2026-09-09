# T07. Validate the proposed deployment state before changing it

Source: R06. Priority: P1. Depends on: nothing. Decision: D02 decided. Size: S.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`ProfileService.update` asks the uploader gate about the old row (`reserveDeploy(existing, ...)` at :335, stamp and chequebook checks against the old values) and then deploys the new row (`runReserved(reservation, row)` at :369). The gate is fail-open when the node does not answer (ChequebookService.ts:157, StampService.ts:258).

## Scope

- Build the proposed row first and hand that same normalised row to the gate, the claim and the write. Guard against the row changing while asynchronous validation runs.
- Group edits build one proposed row per member, with the documented all-or-nothing or reported-partial outcome, and release reservations when validation fails.
- D02: a new uploader start is refused when its node does not answer the stamp or chequebook check, with a retry action. Running uploaders and engine-only recreates are untouched. No automatic shutdown by inference.

## Acceptance

- An invalid old stamp can be replaced by a valid new stamp through the general Edit.
- A valid old stamp cannot authorise an invalid replacement or a different unchecked Bee target.
- Refused edits preserve database state, environment files and running containers.
- Competing edits cannot deploy one request's configuration after validating another's.
- Group edits: tests prove the chosen behaviour and accurate reporting for every member.

## Where the design lives

PRD "**T07.**" in Fable round 1 section 5 and OpenAI round 2 section 4, decision D02.

## Code anchors

ProfileService.ts update :288 to :372, deployNewMembers :943, reserveMembers :873. DeploymentOrchestrator.ts reserveDeploy :249 to :269. UploaderStartGate.ts:42. ChequebookService.ts assertFunded :151 to :174. StampService.ts assertStampUsable :243 to :258.
