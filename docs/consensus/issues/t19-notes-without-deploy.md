# T19. Save deployment notes without a deployment job

Source: UX09. Priority: P2. Depends on: nothing (candidate-state handling coordinated with T07). Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

Notes are saved through the general Edit, which claims the deployment, runs the uploader gate and starts a deploy, so a note cannot be saved while a stamp is invalid or a node is unfunded, and a stale drawer can send old notes with the rest of the fields (ProfileService.ts:341).

## Scope

- `PATCH /profiles/:name/notes`: no claim, no gate, no deploy, no environment file, no image build. Normal auth, same-site check and text validation apply. `NotesCard.tsx:19` uses it.
- The Edit drawer sends notes only when the operator edited them, and the request carries the revision it was loaded with, so a stale drawer cannot overwrite a newer notes save.

## Acceptance

- A notes-only change builds nothing, writes no deployment environment file and starts no job.
- It saves when a stamp is invalid or a node is unfunded, subject to permission and record-existence checks.
- A mixed notes and configuration edit still follows the validated configuration workflow.
- Simultaneous metadata saves and a stale configuration save either preserve both accepted changes or return a clear conflict. Notes are never silently lost.

## Where the design lives

PRD "**T19.**" in Fable round 1 section 5, OpenAI round 2 section 4, T19 line of "Question 8" in Fable round 2.

## Code anchors

ProfileService.ts update :288 to :372 (:341), api routes for profiles, frontend deployments/NotesCard.tsx:19, the Edit drawer.
