# T20. Add repeatable checks and an agreed merge gate

Source: Q01. Priority: P2. Depends on: T10 and the new regressions. Decision: D06 decided (checks required on main-v2, Levi keeps a bypass, agents never push directly). Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- A workflow under `.github/workflows` (none exists): common build, `pnpm -r typecheck`, the common and manager unit suites, meaningful frontend checks.
- A separate, documented Docker-backed job for the container-backed regressions (T01 startup failure, T02 real parser, T03 pinned OME, T05a harness) and the authenticated integration coverage, without production credentials and without paid transactions.
- Skips and unavailable environments are visible. CI success never implies that unexecuted live or paid checks passed.
- Any introduced dependency or action version receives the repository's provenance checks.
- The workflow file is a change Levi merges. Branch protection is Levi's setting, made after the workflow exists.

## Where the design lives

PRD T20 in the task catalog, "**T20.**" in OpenAI round 2 section 4, decision D06.
