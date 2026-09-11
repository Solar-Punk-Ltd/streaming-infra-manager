# T18. Keep version information and actions usable in narrow layouts

Source: UX08. Priority: P3. Depends on: T04a and T08 for the agreed version states. Decision: none. Size: S.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- At 723px and a verified phone-width viewport, version identity, state and actions are usable without an undiscoverable offscreen action column.
- Contract detail expands without overwhelming the main row. Any remaining horizontal scrolling is evident and keyboard usable.
- Long names, error messages and building states do not hide the current default or the tested status.
- Visual evidence records the actual viewport dimensions. A failed viewport override does not count as mobile coverage.

## Where the design lives

PRD T18 in the task catalog and OpenAI round 2 section 4.
