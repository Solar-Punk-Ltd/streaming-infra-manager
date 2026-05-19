# AGENTS.md

This file is read by AI coding agents working in this repository. It describes the conventions, tooling, and reference docs those agents should follow. Edit it directly when those conventions change — re-running `/setup-matt-pocock-skills` is only needed if the structure beneath `## Agent skills` has to change.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) used as `Status:` values in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
