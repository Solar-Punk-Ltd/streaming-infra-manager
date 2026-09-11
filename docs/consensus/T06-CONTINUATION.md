# T06 completed checkpoint, 2026-09-08

**Latest integration:** Accepted at clean `b65f8d9`. Merge `efa6cd5` brings reviewed T04a `5577c94` into the existing T06 branch. RED `74114e9` and GREEN `4e3f53b` ensure fallback reservations resolve one captured descriptor before port work and carry it through start and cancellation. RED `b39fd30` and GREEN `b65f8d9` cancel the exact unused reference after defaults preparation when no script is needed. Older references and port reservations remain intact.

Evidence: 800 manager tests in `/private/tmp/t06-noop-manager-full-green.log`, 24 focused tests in `/private/tmp/t06-noop-reference-green.log`, earlier integrated 280 common tests in `/private/tmp/t06-t04a-common-full.log` and 53 actual PostgreSQL cases in `/private/tmp/t06-t04a-sql-final.log`. All types pass. The last no-op correction did not change SQL, so that suite was not repeated. Root reviewed source and evidence in its separate review tree. Linux kernel firewall validation and the matching-version shared-image harness remain unexecuted. T12 has merged this branch at `fe7899e`, with its direct-ledger phase correction currently paused at RED `53d1724` after an automatic source-edit rejection.

Cross-provider review, OpenAI-hosted. T06 is implemented, reviewed and drafted locally.
This supersedes the older d30db41 and 0d0a825 checkpoints. Do not restart at slice 3.

## Location and boundaries

- Branch: `fix/t06-port-reservations`.
- Clean head: `b8071a1bb6b62a6a467ff72a7e932bffcc238b05`.
- Worktree: `/private/tmp/claude-501/-Users-kisslevente-Documents-git-SolarPunk-streaming-infra-manager/7246732f-5c45-474a-86a0-3098d5031e9c/scratchpad/wt-t06`.
- Base retains the existing T04a/T05a dependency merge. Do not rebase it.
- Main checkout remains `fix/t05a-shared-image-guard` at `3220114`. Its tracked files are clean.
- Levi authorized local implementation and reviewer agents in this conversation. Tests first, separate RED and GREEN commits, one logical fix per commit. Each task row has its own branch. PR bodies stay in `prs/`.
- No pushes, GitHub writes, deployment-host commands, live infrastructure changes or funded operations.
- The 0.5 BZZ fill's submission remains unverified. Do not call it unsent, settled or safe to retry.
- T05b stays with Levi. D04 and D05 inputs remain pending.

## Completed implementation

- Atomic whole-table reservations share the allocation advisory lock with profile and group creation. Physical uniqueness uses daemon identity, protocol and port. Every stored record counts, including stopped profiles. New placement honors the lower of the contract cap and 100.
- Missing or unparseable contracts and incomplete inventory refuse all creation paths before writes or deploys. Private roles cannot occupy fixed public tuples, and managed ports must stay within protected TCP/UDP 10000 to 19999.
- Verified target aliases share a daemon namespace. Bounded read-only target probes tie identity and published/container observations together. Jobs persist their alias and daemon. Inventory readiness is recorded per daemon.
- Boot seeding preserves old slots and status. Paused containers are included. Unknown host-network bindings keep allocation gated. Host UI supports verification and inventory retry with explicit errors.
- Admission uses the captured immutable descriptor and retains the old/new plan union. Later publication cannot alter the reserved job. Failed or uncertain starts retain holds. Only exact known-unstarted references are cancelled.
- Per-service handover requires new container identities and expected bindings. Untouched service and rollback plans remain held. Retained owner sets prevent sequential replacements from erasing another service's claim.
- Removal checks unresolved attempts and rollback holds, then observes absence on the correct daemon. Profile and reservation deletion is atomic under the allocation lock.
- OME has explicit Compose aliases for SRT and HLS. Creation, inventory, admission, handover and export use actual OME ownership. Other SRS and uploader ports remain unchanged. Missing, incompatible or reassigned source mappings refuse OME placement.
- The firewall exporter reads one sanitized database snapshot, immutable current/previous candidates and mandatory service snapshots. It rechecks daemon identity and the database fingerprint after observing bindings. No credentials or environment contents enter the output.
- Retained SRS history stays SRS when the current engine is OME. Unusable unadmitted OME candidates cannot veto complete retained snapshot evidence. Every listed deployment must have covered reservations and claims.
- Authenticated GET `/targets/firewall?alias=localhost` downloads the read-only evidence. It never performs inventory recovery or a deployment.
- The standalone generator consumes `common/src/portPolicy.js` and requires that export before printing any stdout. Unknown/private occupants defeat public allowances. Existing slot-101 RTMP cannot become public through the legitimate v3 rung allowance.
- The generated file replaces only `inet streaming_infra_manager`. IPv4 and IPv6 forwarding use original destination ports. Direct routing from the selected external interface is denied. SSH cannot exempt a protected port. Existing connections and other firewall tables are preserved.
- Operator scope and limitations are recorded in `deploy/README.md`. No firewall was applied.

## Validation and independent reviews

Final head b8071a1:

- Full manager unit suite: 772 passed, zero failures or skips. `/private/tmp/t06-final-manager-tests.log`.
- Full shared-package suite: 280 passed, zero failures or skips. `/private/tmp/t06-final-common-tests.log`.
- Real disposable PostgreSQL suite: 17 passed, zero failures or skips. `/private/tmp/t06-final-sql-tests.log`.
- Full workspace typechecking passed after API/generator integration. Final manager typechecking passed again after the last correction. `/private/tmp/t06-types-firewall-generator.log` and `/private/tmp/t06-final-manager-types.log`.
- `git diff --check` passes. T06 worktree is clean.
- The database tests cover migrations 001 through 012 and 015 through 019. Migrations 013 and 014 belong to other task branches and were not included.
- Offline browser verification of the Host card covered incomplete inventory, successful retry, target verification and a persistent unreachable-target error. It did not visit the live site.
- Reviewer `review_t06_inventory` cleared the OME, immutable-reader and API corrections through 7b6cadd.
- Reviewer `review_t06_gates` independently reproduced the last zero-coverage issue, then confirmed b8071a1 fixes both validation paths. No findings remain within those bounded reviews.
- nftables syntax and kernel behavior were not executed. No local nft binary was available. Ordered generated-policy tests cover both families, transports, every supported private API/RTMP port, DNAT, direct routing, interface scope and established connections. The DNAT bitmask form was checked against the nftables project documentation. Operator Linux validation is still required before application.
- The matching-version T05a harness on Engine 29.1.3 and Compose v5.1.4 remains separate future work. Do not run the R04 script on the host.

## Cleanup

The exact task-owned PostgreSQL container
`56e79693aa100762b7a4b1e3e116065f55144a3ec66c9735d21de1e937b2466f`
was stopped and its removal verified in the local `desktop-linux` context.
It held generated test schemas only. No image was pulled.

The offline browser tab is closed. Task-owned mock/Vite processes 2497 and 2516
were stopped earlier and ports 9893 and 5193 were verified free.
No T06 test server or database is intentionally left running.

## Continue from here

T06 local PR draft: `prs/t06-ports-and-firewall.md`. Levi publishes it.

Next implementation row is T09, transaction-identity recovery for chequebook moves.
Read `issues/t09-money-by-transaction.md`. It depends on T10, not on the T06 branch.
Create or reuse the row's own worktree after checking local branches and worktrees.
Never retry or inspect the funded live fill as part of implementation.

Remaining rows: T09, T12 after T07/T11, T14 after T09/T12 and Levi's D04 numbers,
T15, T18, T21, and T22 after Levi's D05 inputs and explicit live authorization.
T14 says not to request its numbers before they block work. T05b stays with Levi.
