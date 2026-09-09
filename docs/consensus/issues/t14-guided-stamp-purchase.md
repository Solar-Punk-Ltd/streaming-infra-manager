# T14. Add a guided stamp purchase flow

Source: UX11. Priority: P3. Depends on: T09 and T12. Decision: D04 decided, the numbers are still owed by Levi (preset capacities and lifetimes, and the ceiling). Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- A guided view maps a capacity and lifetime choice to the exact depth and per-chunk amount the existing API uses, and shows the BZZ cost, the known gas requirement and the estimate uncertainty before submission.
- No preselected spend. The accepted spending ceiling is enforced in the submission path, not only displayed. A quote that became stale never authorises a larger spend.
- Unavailable or stale prerequisites never look like a confirmed quote. Insufficient funds and insufficient lifetime get specific corrective guidance.
- The expert inputs remain, with validation and cost and lifetime feedback from the same calculations.

## Waits for

Levi's D04 numbers. Do not request them before they block work.

## Where the design lives

PRD T14 in the task catalog, "**T14.**" in OpenAI round 2 section 4, decision D04.
