# T25. The uploader starts whatever its chequebook and postage readings say

Source: Levi, 2026-09-17, on the refused deploy of `abr-pool-stage-1`. Priority: P1 on his word. Depends on: T24 for the address. The gate is this row's own work. Decision: D15, Levi, 2026-09-17: "The uploader and engine should be able to start no matter what the status of the chequebook is", and a four second timeout on a chain-backed read is too short. Size: S in the stack, plus the pin bump here.

The stack's `stream-uploader` refuses to start when `ChequebookGate` cannot read a node's chequebook or reads one under 0.5 BZZ, and `PostageGate` refuses on a batch it cannot read or that is nearly out. Both reads run on `BEE_REQUEST_TIMEOUT_MS`, 4000 ms, a per-request deadline derived for the upload loop. A chequebook balance is a contract read through the node's RPC endpoint and can take longer than that on a public endpoint. On 2026-09-17 the gate's refusal hid the real fault (T24) behind "chequebook is absent or unreadable: timeout of 4000ms exceeded", and docker restarted the uploader in a loop until the deploy guard refused the deploy.

## Scope, in the stack (Solar-Punk-Ltd/swarm-hls-stream, branch off main-v3)

- The two startup gates observe and report: they log the reading, or the refusal text as a warning, and the uploader starts either way. `UPLOADER_START_GATES=refuse` restores the refusal for an operator who wants it. Default `chequebook-warn`, as built: the chequebook gate warns, and the postage gate refuses a batch the node answered about and warns about one it could not read (decision 7 b, below).
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

## Built, 2026-09-17, the stack half, and decision 7

Branch `fix/uploader-start-gates-warn` of Solar-Punk-Ltd/swarm-hls-stream, 32 commits on
7e2de6f7, merged fast-forward into main-v3 at 55b22bf1 on Levi's word ("so the hls is okay? if
yes merge to main-v3") after the verification box passed that head at standard depth, and pinned
here in 7b2312f. What it does:

- The uploader's API listens first. A node that does not answer is waited for, one second
  doubling to thirty, without giving up, and `/health` answers 503 `waiting_for_node` with the
  node's URL (credential stripped), the attempts, the last error and since when. Everything under
  `/stream/*` answers 503 with `Retry-After: 5` until the node answers.
- The two start gates get their own budget, `START_GATE_TIMEOUT_MS`, 20 seconds by default and
  ten minutes at most, instead of the upload loop's four seconds.
- `UPLOADER_START_GATES` has three values. `chequebook-warn`, the default: the chequebook gate
  warns on everything, the postage gate refuses what the node answered and warns what it could not
  read. `warn`: both warn. `refuse`: both refuse, the old behaviour unchanged. A blank value is the
  default and a misspelt one is refused when the config loads.
- A gate that warns reads every rung rather than stopping at the first, and the warnings are
  latched on `/health` as `start_gate_warned` with the gate's name and the rung, nothing more,
  because `/health` is unauthenticated. `deploy/scripts/assert-started.sh` confirms a warned start
  and prints the gates and rungs.

**Decision 7, Levi, 2026-09-17, option b.** With the chequebook gate warning and the postage gate
refusing, a rung whose node did not answer at all still counted as a bad batch: the postage gate
threw, the wait read the timeout in the message and retried for ever, which was the shape of the
incident this row began with. Levi's ruling: the postage gate refuses only a batch the node
answered about, `usable` false, time left under the floor, utilization over the ceiling, or a 4xx
such as bee's 404 for a batch it does not hold. It warns, and the uploader starts, when the batch
could not be read at all: a transport failure or a timeout, a 5xx, or an answer with no readable
batch fields. Every gate refusal now says which of the two it is, and the runner in
`libs/StartGates.ts` decides from the mode what the boot does about it. The gate messages state
what was found and what fixes it and no longer claim the uploader refuses, because under a warning
mode the same line ends with the uploader starting anyway. One consequence worth knowing: on a pool
whose nodes answer nothing, the default mode now reads every rung before it starts, about 160
seconds on four nodes, where it used to stop at the first, and such a rung is latched on `/health`
where the container previously died.

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

The stack half was merged into main-v3 at `55b22bf1` and pinned here in
`7b2312f` the same morning, as the section above records, and the pin has moved
on since, on `feat/manager-line`, which carries it. A deployment reports the new
fields once the host runs that pin. One still on an older build reports none of
them and the manager reads that as no waiting state reported.

`d4a4e8c` closed the half that was left: `ChequebookService.assertFunded`, the
gate's second check, was still throwing `BeeNodeError` on a node that did not
answer the chequebook read, from commit `50e778e` under D02, so a silent node
refused the start one check later and D16 was only half in effect. It now logs
the node it could not reach and lets the start through.

The owner then ruled, the same day, that this check never refuses a start at
all, and that the postage batch keeps refusing in the stack. So a balance under
the floor and a balance the node answered with that cannot be parsed are
warnings too. An operator who wants an uploader up on an unfunded node gets it
up, and what that costs is uploads that stall, which the deployment page shows
from the uploader's own health. The manager's one remaining refusal is the stamp
check, for a batch the node itself reports as unknown, expired or not usable.
`409 chequebook_unfunded` is gone with it. Nothing threw it once the check
stopped refusing, so the class `ChequebookUnfundedError`, the error handler's
mapping of it, the sentence `uploaderUnfundedReason` in `common`, and the
offline mock's own `chequebookRefusal` were all removed rather than left to be
read as a state the manager can reach. The frontend turned out never to have
had a branch for that code at all, rendering whatever the API said through its
one `ApiError` path, so there was nothing to take out there. The offline mock's
own suite now pins the opposite property, that every one of its deployments
starts whatever its funding evidence says, because a mock that grows a refusal
production does not have reports every such start as a failure on a laptop while
the host is fine. `docs/consensus/T11-CONTINUATION.md` still names the code,
and is left alone: it is the dated record of what was decided in April rather
than a description of the manager now.

Three smaller things followed. `0772067` moved the five deploy-target spellings
that mean this machine into `LOCAL_DEPLOY_TARGETS` in
`manager/src/domain/localHost.ts`, so `StampService` and `UploaderHealthService`
read one set rather than a copy each. `fa576d7` put the node's last error on the
waiting line, "4 attempts so far, last error: timeout of 20000ms exceeded", so
the step says why the node is being waited for and not only that it is.
`73f347a` gave the offline mock the route, `ok` by default and
`?state=waiting_for_node`, `?state=warned` or `?state=ok` to move it, sticking on
the node entry so the page's ten second re-read keeps showing it.
