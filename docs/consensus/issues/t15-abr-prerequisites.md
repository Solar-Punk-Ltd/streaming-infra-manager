# T15. Connect ABR prerequisites and clarify resource categories

Source: UX07. Priority: P2. Depends on: T12. Decision: none, the navigation names go to Levi's walkthrough as recommendations. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- Choosing an ABR uploader with no local pool explains the prerequisite and offers a route to create one, with the uploader draft retained (`wizardState.ts:183` poolMode, `UploaderSettings.tsx:22`).
- Returning from pool setup selects the intended compatible pool and shows any remaining funding or stamp blockers.
- External pools, custom deployments and all existing group capabilities remain available.
- Streams, Viewers, Storage pools and Groups as an organisational view are proposed wording for Levi's walkthrough, not decided here. Any removal or substantial change of a user-facing capability is surfaced to Levi, never adopted silently.

## Where the design lives

PRD T15 in the task catalog, "**T15.**" in Fable round 1 section 5 and OpenAI round 2 section 4.
