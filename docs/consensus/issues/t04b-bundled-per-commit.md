# T04b. Publish the bundled stack per commit

Source: R03 (the bundled tree, raised by OpenAI round 3). Priority: P1. Depends on: T04a. Decision: none. Size: S to M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

The manager's own `deploy/deploy.sh` rsyncs the bundled stack over the mounted tree (deploy/deploy.sh:90). SRS and OME bind-mount templates and entrypoints from that tree, so a container restart after a manager deploy runs an old container on replacement files.

## Scope

- The manager's deploy publishes each bundled stack into `<versions>/bundled.builds/<commit>/` as a fresh directory with a manifest, never over an existing one.
- The api resolves the bundled root from `manager/.stack-commit` to that directory. `SHLS_ROOT` stays the fallback only for explicit legacy state, and the Versions page says which is in use.
- The same reference and prune rules as T04a apply to bundled builds. The original legacy mount tree and previously published bundled builds are preserved.

## Acceptance

- First migration: an engine mounted from legacy A keeps reading A after B is published and after a container restart, until an explicit rollout selects B.
- The same holds between two published bundled builds.

## Where the design lives

PRD "##### Question 1, T04. Agree with all six cases and both boundaries" (Fable round 3, "Bundled consistency, T04b"), "##### Question 1. T04a and T04b" (OpenAI round 4).

## Code anchors

deploy/deploy.sh:90, manager/src/domain/versions/stackPaths.ts, versions/bundledCommit.ts, manager/index.ts (SHLS_ROOT).
