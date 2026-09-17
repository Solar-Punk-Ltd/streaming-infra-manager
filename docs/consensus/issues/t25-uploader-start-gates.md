# T25. The uploader starts whatever its chequebook and postage readings say

Source: Levi, 2026-09-17, on the refused deploy of `abr-pool-stage-1`. Priority: P1 on his word. Depends on: T24 for the address, this row for the gate. Decision: D15, Levi, 2026-09-17: "The uploader and engine should be able to start no matter what the status of the chequebook is", and a four second timeout on a chain-backed read is too short. Size: S in the stack, plus the pin bump here.

The stack's `stream-uploader` refuses to start when `ChequebookGate` cannot read a node's chequebook or reads one under 0.5 BZZ, and `PostageGate` refuses on a batch it cannot read or that is nearly out. Both reads run on `BEE_REQUEST_TIMEOUT_MS`, 4000 ms, a per-request deadline derived for the upload loop. A chequebook balance is a contract read through the node's RPC endpoint and can take longer than that on a public endpoint. On 2026-09-17 the gate's refusal hid the real fault (T24) behind "chequebook is absent or unreadable: timeout of 4000ms exceeded", and docker restarted the uploader in a loop until the deploy guard refused the deploy.

## Scope, in the stack (Solar-Punk-Ltd/swarm-hls-stream, branch off main-v3)

- The two startup gates observe and report: they log the reading, or the refusal text as a warning, and the uploader starts either way. `UPLOADER_START_GATES=refuse` restores the refusal for an operator who wants it. Default `warn`.
- The startup reads get their own budget, `START_GATE_TIMEOUT_MS`, default 20000, independent of the per-request deadline of the upload loop.
- Tests in `packages/stream-uploader/test` cover: warn by default on an unreadable chequebook, warn on a low chequebook, refuse under `refuse`, and the separate timeout.

## Scope, in the manager

- Pin the stack commit that carries it (bundled version bump), on Levi's word for the merge into main-v3.
- The readiness page of an uploader shows the gate's warning, read from the uploader's log tail, so a start that went through on an unfunded node is still visible.

## Open for Levi

D02 of 2026-09-07 says the manager refuses a new uploader start when its node does not answer (`assertStampUsable`, `uploaderGate`). D15 is about the stack's own gates. Whether D02 stays is his call, and nothing here changes it.

## Where the design lives

`packages/stream-uploader/src/index.ts`, `libs/ChequebookGate.ts`, `libs/PostageGate.ts`, `utils/config.ts` in the stack. D02 in ../PRD.md.
