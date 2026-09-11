# T06. Reserve physical ports and validate firewall exposure

Cross-provider review, OpenAI-hosted.

Local draft only. Branch `fix/t06-port-reservations`, clean head `b65f8d9`.
Includes the accepted T04a `5577c94` corrections and existing T05a dependency. Levi opens the PR.

The latest reviewed integration captures one immutable descriptor before port work and carries it through start and cancellation. When no script is needed, it releases only the exact unstarted build reference after defaults preparation, preserving older references and port reservations. Final validation passes 800 manager tests and types. The preceding integration passed 280 common and 53 actual PostgreSQL cases. Details and logs are in `../T06-CONTINUATION.md`.

New deployments reserve their version's complete port table in the same transaction
that allocates the profile or group. Reservations use Docker daemon identity,
protocol and port, so another SSH alias cannot allocate the same physical port.
Missing contracts, unknown targets and incomplete inventory refuse creation.
The cap is the lower of the stack limit and 100, including stopped records.

Redeploy holds old and new ports until container and binding observations prove
each service's replacement. Failures and rollback references retain their holds.
Removal verifies absence before atomically deleting the profile and reservations.
OME's derived SRT/HLS ports now carry the actual OME service identity throughout.

The Host card exposes verification and inventory recovery. A new authenticated,
read-only inventory download captures retained immutable contracts, reservations
and daemon-bound observations. The firewall generator requires this evidence and
uses the same policy constants as allocation. It refuses the existing slot-101
RTMP collision while retaining legitimate v3 rung peer connectivity.

Generated rules replace only the manager's own table and cover IPv4 and IPv6.
They protect translated ports and deny direct routing from the chosen external
interface. They preserve existing connections and other applications' tables.
The README describes this scope, including the impact on a host used as a router.

## Validation

- Tests-first commits preserve the failing regressions and their fixes.
- 772 manager tests and 280 common tests pass, with zero failures or skips.
- 17 real PostgreSQL tests pass using disposable local schemas, including
  concurrent allocation, whole-group rollback, retained owners and removal.
- Workspace typechecking and final manager typechecking pass.
- Offline browser checks pass for inventory retry, target verification and errors.
- Two independent reviewer worktrees were used. The final coverage correction
  was independently confirmed. No findings remain within those bounded reviews.
- `git diff --check` passes and the branch is clean.

## Limits and operator follow-up

- No live site, deployment host or real funds were used. No image was pulled.
  The disposable local database and test servers were stopped.
- Generated nftables policy was tested as ordered rules, not executed by a Linux
  kernel. Validate the candidate with the target nftables version before applying it.
- The exporter deliberately refuses mutable legacy or missing build history,
  unresolved operations and incomplete retained ownership. A downloaded snapshot
  cannot prove that the host has remained unchanged.
- Established connections survive a new ruleset. The candidate does not remove
  older generic firewall tables. Review coexistence and direct-routing needs.
- Migrations 001 through 012 and 015 through 019 were tested together. Other
  remediation branches' migrations 013 and 014 were not part of this database run.
- The funded 0.5 BZZ fill's submission remains unverified. This change neither
  retries it nor declares an outcome. T05b, D04/D05 inputs and the later
  matching-version T05a harness remain outside this row.
