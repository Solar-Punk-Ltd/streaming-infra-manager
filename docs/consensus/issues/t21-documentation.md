# T21. Reconcile documentation with the agreed implementation

Source: Q02. Priority: P2. Depends on: the tasks it documents. Decision: none. Size: S.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- `docs/features/stack-versions.md:3` to :8 carries a stale status header. Distinguish implemented behaviour, remaining planned work and owner decisions, and record decision D6 of 2026-09-07 (new deployments only pick a version).
- Engine configuration docs describe the real validation and recovery guarantees. Funding docs describe the real transaction states.
- Test setup, commands, authentication and cleanup boundaries match the harness after T10.
- STATE.md and CONTEXT.md references are investigated for moves or deletion before anything is created. Absent CONTEXT.md or ADR files are not a gap (docs/agents/domain.md:13 says to proceed silently). Stale references are corrected without manufacturing history.
- Every agreed task has a local issue entry (this directory) or a traceable completion record.

## Where the design lives

PRD T21 in the task catalog and OpenAI round 2 section 4.
