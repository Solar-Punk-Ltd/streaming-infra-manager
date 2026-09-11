# T06. Align allocation, port contracts and firewall exposure

Source: R05 (P2 after the debate: one hundred occupied records, stopped included, are needed before slot 101 exists). Depends on: T04a for the pinned contract. Decision: D01 decided. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

The allocator counts slots from a `generate_series` join under an advisory lock, bundled allows 999 slots while main-v3 allows 99, the firewall generator refuses `--max-slot` above 100, and bundled slot 101 physically collides with main-v3 slot 1 (ports 11011 to 11016). `StackPortVar` has no protocol, while the compose file maps `10080/udp`. A remote target alias could open a second reservation namespace for one daemon.

## Accepted design, in short

- `port_reservations(host, protocol, port, profile_name, service, state, reason)`, unique on host, protocol and port, where host is the daemon id. State is planned, active or releasing. Allocation inserts the whole shifted table for the slot in the transaction that inserts the profile, under the existing advisory lock, so a group's members are all reserved or none.
- Protocol comes from the version's compose `ports:`, both short and long forms, explicit protocol or TCP by default. An unparseable mapping or a missing port table refuses allocation with the reason.
- Cap `min(contract.maxSlot, 100)`, counting every stored record, stopped included. Lower version limits stay.
- `deploy_targets(alias, daemon_id, verified_at)`: the local id from `docker info` at boot, a remote alias verified over the same ssh path `deploy.sh` uses, read-only, on first use and on demand. Reservations and T05a's lock key on the daemon id. An unverified alias refuses new allocation with "target not verified". Every job persists its alias and daemon id.
- Seeding: a one-time step reserves every existing profile's table and marks active what container inspection finds bound. Until it completes, new allocation answers "the reservation inventory is still being built". Nothing existing is renumbered or stopped.
- Handover: admission adds planned reservations for a new contract and never drops active ones. A port moves to releasing only after inspection finds it unbound, and is deleted only when no plan needs it. A failed recreate leaves the old active reservation. Reservations are per service. Stopped profiles keep theirs.
- The job uses the contract in T04a's captured descriptor from admission to launch. A version update that changes the port table marks its deployments for revalidation at their next admission.
- The firewall generator reads the same policy constants. A permitted public peer endpoint never implicitly permits an administrative or media endpoint on the same port.

## Acceptance

- Boundaries 99, 100 and 101. Two free slot numbers whose version-specific ports overlap. A whole group. Concurrent allocations. A port-table change on Update.
- Pause A after admission and before old-container removal, request p for B, then fail A's recreate: B is refused.
- Move only A's engine: the uploader's reservations remain.
- Publish contract Y after A reserved X: the job runs on X throughout.
- Seed an existing profile and race a new allocation for its port: allocation stays gated.
- Two aliases of one daemon allow exactly one reservation of p. Distinct daemons reserve p independently. A local and a remote alias of one daemon share one namespace.
- Bundled slot 101 cannot become public through a rung-peer allowance. Firewall tests evaluate the whole generated policy.

## Where the design lives

PRD "**Question 6, T06 and D01**" (Fable round 2), "##### Question 4. T06 port reservation table" (OpenAI round 3), "##### Question 4, T06" (Fable round 3), OpenAI round 4 Question 3, "##### Question 3, T06" (Fable round 4), OpenAI round 5 Question 3.

## Code anchors

ProfileRepository.ts insertWithFreeSlot :51 to :96, ProfileService.ts create :188 to :275 (maxSlotOf :244), DeploymentGroupRepository.ts :212 to :232, versions/portTable.ts, versions/stackContract.ts (SLOT_CAP_RE :31, DEFAULT_MAX_SLOT), common/src/stackVersions.ts (StackPortVar :30, DEFAULT_MAX_SLOT :110), the firewall generator script, DeploymentOrchestrator.ts:660 (`--host`), stack `_lib.sh:60` to :70 and :210, deploy/docker-compose.yml:108 to :113.
