# AGENTS.md

This file is read by AI coding agents working in this repository. It describes where this
repository keeps its issues, its decisions and its reference documentation. Edit it directly when
those conventions change.

## Issues and decisions

Issues live as tracked markdown files under `docs/consensus/issues/`, one per remediation row,
named `t<NN><a|b>-<slug>.md`. Each opens with a title line and then a single header line of the
form:

```
Source: R01. Priority: P1. Depends on: T01a. Decision: none. Size: M.
```

`Priority` is the estate's P1 to P3 scale. There is no separate `Status:` line on an issue file.

The five triage labels the review used, `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`, are defined and applied in `docs/consensus/PRD.md`, which also
carries every review round, the task table and Levi's decisions D01 to D10. Decisions D11 to D14
were taken during the slices built after the merge and live in their briefs and fixes files in the
same directory, which `docs/consensus/README.md` lists in order. Decisions D15 and D16 (2026-09-17:
the stack's uploader starts whatever its chequebook says, and the manager starts it even when its
node does not answer, and decision 7 of the same day on the postage gate's two readings) live in `docs/consensus/issues/t25-uploader-start-gates.md`, and rows T23 to
T27, added the same day, are listed at the end of `docs/consensus/issues/README.md`.

`docs/consensus/prs/` holds one draft pull request body per row, kept as the per-row record of
what was built and checked. `docs/consensus/README.md` maps the whole directory.

Sessions also write working notes under `.scratch/`. That directory is gitignored and local to
one machine, so nothing there can be cited as a source. When a scratch file matters, its tracked
copy under `docs/consensus/` is the one to reference.

## Reference documentation

This repository has no `CONTEXT.md` and no `docs/adr/`. Domain vocabulary and architectural
reasoning live in the pages that describe the feature they belong to:

- `README.md` for the layout and the submodule.
- `deploy/README.md` for putting the manager on a server and opening it to the internet.
- `manager/README.md` for the API, the authentication model and the environment.
- `docs/features/` for one page per feature.
- `docs/ci.md` for what the two workflows run and what they prove.
- `docs/testing/` for the test topology of individual remediation rows.
- `docs/handover/main-v2-remediation.md` for the dated record of what was built and what was
  found on the live host.

A statement in any of these carries the date and the commit it was true at. When you change
behaviour, change the page that describes it in the same branch.
