# T04a correction handoff, 2026-09-08

## Guarded removal and marker checkpoints

Cross-provider review, OpenAI-hosted. Final clean `c55c9d93b17b75619b239104099de28cdfff2a43` is accepted. SQL/callback guard `635bfd7`, marker `6a34810`, new-version insert `bf86a73`, future-ID refusal `63febb4` and ancestor validation `a003d83` are independently reviewed. Fixture correction `e11f16a` and fixed malformed-marker diagnostic `4ca688c` passed the complete compatibility run: 194 actual SQL cases across 11 files, 999 manager tests, 289 common tests, 18 frontend tests and workspace types. Logs `/private/tmp/t04a-removal-all-sql.log`, `/private/tmp/t04a-removal-all-manager-final.log` and `/private/tmp/t04a-removal-all-final-types.log`.

Final RED `4d083d8` reproduced a failed first build whose versions parent never existed, with the symlink control passing. GREEN `c55c9d9` validates the nearest physical parent, creates the missing versions parent, then repeats full physical validation before marker or payload access. Final 45 removal SQL, 70 focused unit checks and workspace types pass. Logs `/private/tmp/t04a-removal-first-use-green.log`, `/private/tmp/t04a-removal-final-focused.log` and `/private/tmp/t04a-removal-final-check-types.log`. No real runner ran. The local PR draft is rewritten around this checkpoint.

The shared parent validator rejects arbitrary ancestor symlinks while permitting only verified macOS /tmp and /var aliases. Marker reads remain bounded, nofollow and identity-checked, with file plus parent sync before deletion. Later T04b/T01 integration must preserve marker checks in the extracted job-claim path. Final successful-job ownership and immutable runtime preparation remain separate obligations.

## Quota resume and crash-safe deletion design

Cross-provider review, OpenAI-hosted. Current HEAD `34c9f51` commits guarded-removal RED tests. An unfinished edit remains in `manager/test/database/versionRemoval.test.ts`. No production removal changes were applied before interruption. The worker resumed with its exact database `6b755f793656af867ad33f9564fabc1a5d06f2d324a88cad91fe58f748fd656b`, loopback 61175, `t04a_test`.

Database rollback cannot restore partially deleted files. The existing complete marker and manifest can survive deletion of a payload leaf, so the current admission check can admit a torn artifact. Root approved a durable sibling `<name>.removal.json` marker written atomically and synced with its parent before payload deletion. All SQL guards and owned-path validation precede it. It survives rollback and restart, and matching identity permits idempotent removal retry. Admissions, execution registration and update/markBuilding check it under the version lock for both layouts. Malformed, unreadable or symlink markers refuse. A valid tombstone with a retired version ID may be ignored by a later same-name row. No marker is cleared after commit. Tests must cover partial deletion with surviving complete/manifest, rollback and simulated restart, legacy roots, exact retry, concurrent update, and valid same-name reuse. This design is not yet implemented or accepted as complete.

## Latest accepted dependency and competing-update correction

Cross-provider review, OpenAI-hosted. T04a dependency merge `510db2d` records exact accepted a7d4145 and is independently accepted. It passed963 manager,289 common,18 frontend checks and workspace types. No package versions were introduced.

Root found that an update waiting behind deletion used `building ?? version` after markBuilding returnedNULL, then started a build for the deleted row. REDc29697a plus test-field correction86147a7 and GREENc74ab13 close that path. The held runner test refuses with404 before scripts or files, with35 focused checks and manager types passing. Guarded removal itself is still in progress.

The repository callback design is approved, including refusal of terminal shipment receipts before files because their existing FK would otherwise reject the eventual DELETE. Expected identity must be copied before lock waits. No receipt deletion is introduced. Both build/removal lock orders join the previously recorded reference/FK races.



## Current next slice, 2026-09-09

Cross-provider review, OpenAI-hosted. `implement_t12_readiness` now owns `/private/tmp/t04a-codex` exclusively. T11 was left clean and accepted atb9fb144. The worker must verify T04a5577c94, merge exact accepted helper dependencya7d4145, and validate before new work. Moving T04b HEAD is not the dependency target.

The new bounded correction is guarded version removal. Current service prechecks happen outside the deletion transaction, while removeCheckout swallows filesystem errors. A retained job, operation, shipment or execution can therefore lose its files. Root approved a design proposal before implementation: version FOR UPDATE, fresh identity/bundled/default/building/assignment checks, every unresolved reference kind, pending shipments including unassigned candidates, and unreleased execution records independent of reference integrity. Only then may a callback delete validated owned paths. Use the same connection for row deletion, retain the row on file failure and support a later retry.

Tests must prove every hold blocks before the callback, reader failure leaves files/row intact, both registration/removal lock orders, concurrent FK assignment, failure/retry and successful unheld removal. Synthetic files and a newly owned cached-image database only. The existing62527 fixture belongs to the other worker on T04b and must not be touched. No actual engine build, deployment, host or GitHub action is authorized.

## Earlier accepted corrections

Cross-provider review, OpenAI-hosted. Clean `fix/t04a-immutable-builds` at `5577c94` in `/private/tmp/t04a-codex`. Root reviewed the final code from `/private/tmp/t08-review-codex` and checked the execution logs. The four bounded corrections are accepted. Aggregate integration is still in progress.

| Regression | RED | GREEN | Evidence |
| --- | --- | --- | --- |
| Snapshot selected before row lock becomes stale after publication/pruning | a427da9 | e6e409b | 28 intended SQL failures and four controls, then32 pass |
| Initial preparation failure leaves DEPLOYING | 54d5398 | 6a4e5f7 | Three intended failures, then17 relevant pass |
| Missing version silently falls back to bundled | 7df0db4 | 77c0344 | Eight intended failures, then29 relevant pass |
| Malformed builds layout with missing root/id falls back to legacy | 92fed27 | 5577c94 | Three unit and four SQL failures, then53 focused unit and36 SQL pass |

Final logs: `/private/tmp/t04a-manager-full-with-env.log` (585 pass), `/private/tmp/t04a-common-full.log` (265 pass), `/private/tmp/t04a-malformed-root-sql-green.log` (36 pass), and `/private/tmp/t04a-{manager-final,common,frontend}-types.log`. No failed or skipped cases. The first manager run lacked the inert DATABASE_URL import precondition and was not green. The explicit inert-variable rerun passed all585.

The worker owns container `285c10f9f8ae41c877fb54fe88f53e2ec3b8bb9ae3808872c02cee74bbadbe9a`, loopback62527. It remains active for the approved T06/T12 integration. It uses cached postgres:16-alpine, no image pull or persistent volumes. Existing synthetic test schemas and artifact directories were cleaned by awaited hooks. Do not stop it while the worker owns it.

Next approved sequence: local dependency merge into existing T06 at b8071a1. Test first and fix the fallback descriptor being resolved after port preparation. The captured reservation must reach start and exact reference cleanup. Preserve daemon checks, atomic ports and cancellation. Run SQL/full checks, obtain root review, then merge updated T06 into T12 and separately correct its direct ledger phase writer. Root owns shared drafts. No host, GitHub or main-v2 operation.
