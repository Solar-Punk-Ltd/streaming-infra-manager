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

## D02 amended: decision D16, Levi, 2026-09-17

D02 of 2026-09-07 said the manager refuses a new uploader start when its node does not answer (`UploaderStartGate.assertCanStart`, `StampService.assertStampUsable`, which throws `BeeNodeError` "did not answer the stamp check, so the uploader was not started"). Levi's word on 2026-09-17: "we should be able to start the uploader but maybe say its node not available, try to reconnect or something". So, as a second phase of this row after the gates:

- The manager starts the uploader even when its node does not answer. The refusal becomes a state the deployment shows: the node is not available and the uploader is waiting for it. An unknown or expired stamp the node did report stays a refusal, because the node answered and said so.
- In the stack, an uploader whose node does not answer at start does not exit. Today `StreamCatalog.init` reads the catalog feed from the node and any other failure than an absent feed ends `start()` with "Failed to start" and exit 1, docker restarts the container, and the deploy guard reads the restart as a service falling over. Instead the uploader logs that its node is not available, keeps trying on a backoff, reports that state on its own health route, and finishes starting when the node answers.
- The deployment page and the list show "Node not available, uploader waiting" from that health state, and clear it when the node answers.

## Where the design lives

`packages/stream-uploader/src/index.ts`, `libs/ChequebookGate.ts`, `libs/PostageGate.ts`, `utils/config.ts` in the stack. D02 in ../PRD.md.

## Built, 2026-09-17, the manager half of D16

`4fe7e20` turned the manager's own refusal on a silent node into a warning that
names the profile and the node URL, leaving `StampNotUsableError` exactly where
it was for a batch the node answered about. `1b65b22` added
`manager/src/domain/UploaderHealthService.ts`, which reads a deployment's
`stream-uploader` on its own API port for that deployment's port slot, under a
three second budget, and answers one of `ok`, `waiting_for_node`, `warned`,
`unhealthy`, `unreachable` or `not_deployed`. `4d8db8d` put that behind
`GET /profiles/:name/uploader-health`. `4d57267` gave the deployment page the
reading, so the **Uploader running** step names the node being waited for, its
attempts and since when, or the gate and rung that warned. The reading's type is
`common/src/uploaderHealth.ts`, shared because the manager writes it and the page
renders it.

The stack half is on `fix/uploader-start-gates-warn` in
`Solar-Punk-Ltd/swarm-hls-stream`, pushed and not pinned here, so a deployment on
the pinned `7e2de6f7` reports none of the new fields and the manager reads that
as no waiting state reported.

⚠️ Not built, and the owner's to rule on: `ChequebookService.assertFunded`, the
second check of the same gate, still throws `BeeNodeError` on a node that does
not answer the chequebook read (`manager/src/domain/ChequebookService.ts`, the
catch at line 188, from commit `50e778e` under D02). So on a deployment with its
own Bee node a silent node still refuses the start, at that check rather than at
the stamp check, and D16 is only half in effect. `manager/README.md` has said
since before either change that a chequebook the node cannot be asked about does
not block the deploy, which is the behaviour D16 asks for and not the behaviour
the code has.
