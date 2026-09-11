# T22. Complete a controlled live E2E acceptance run

Source: Q03 and Levi's original request. Priority: required acceptance. Depends on: T10 and the relevant fixes. Decision: D05 decided, the numbers are still owed by Levi (spending cap, duration, what to publish, disposition of the node's funds). Size: L, human-paced.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- Record the manager SHA, the streaming-stack SHA, Docker image identities, the target host, the exact test resources and what else is running. Docker, Compose and port inventory are part of phase 0 as well as the final evidence.
- Before publishing, verify connectivity, gas, wallet funds, the chequebook floor, stamp usability, lifetime and capacity, and host resources. The preflight refuses to start on an unmet prerequisite.
- Capture the complete service-health and metrics surface before and after, diff the whole result, record limitations. No throughput benchmark from a resource-bound run.
- Exercise create, edit, custom configuration refusal, application and recovery, reset, stop and start, and viewer handoff, verifying state after each step including page reload and event-stream reconnection.
- Verify the actual chequebook transaction and stamp purchase, then publish identifiable fresh content and play that same content through the intended viewer, with a bounded duration and continuity criteria set before the run.
- Exercise group creation, edit and resize and the ABR pool, uploader and viewer path on authorised isolated resources, asserting stream identity and quality outputs.
- Investigate the earlier playback pauses in a supported browser, keeping browser limitations apart from product failures.
- Cleanup follows the agreed inventory and funds plan. The funded review node is kept until Levi decides its disposition. The 0.5 BZZ fill's transaction identity is rechecked before any retry. Human transaction or credential steps are explicit, never reported as automated passes.

## Waits for

Levi's D05 numbers. No paid step runs before the cap and the duration are set.

## Where the design lives

PRD T22 in the task catalog, "**T22.**" in OpenAI round 2 section 4, decision D05, the evidence section on the funded deployment.
