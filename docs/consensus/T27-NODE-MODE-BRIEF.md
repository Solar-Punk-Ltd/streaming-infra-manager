# T27 brief: choose a Bee node's mode and its RPC endpoint when it is created

Status: active, 2026-09-17. Row: `issues/t27-bee-node-mode.md`. The common and manager half landed on
`main-v2` as `1c26203` to `1c8fc25` the same day, the frontend half and the stack half were in progress when
this was written, and a fixes file follows the reviews. Written after the T25 stack branch was merged into
main-v3 at `55b22bf1` and pinned in `7b2312f`, on which the stack half of this row is branched.

## What this is, in one paragraph

A Bee node runs in one of two modes. A **light** node talks to the Gnosis chain through an RPC endpoint,
deploys a chequebook, needs gas in xDAI and BZZ for its chequebook and stamps, and can publish. An
**ultra-light** node has no chain, no chequebook and no gas, and can only download. The stack hard-codes the
mode per service: every publisher node is light and the viewer gateway is ultra-light, and the RPC endpoint is
one value for a whole deployment, the public `https://rpc.gnosischain.com` unless the deployment's env says
otherwise. Levi's ruling of 2026-09-17: the mode and the endpoint are chosen when the node is created, the
node's page shows both, an ultra-light node has no funding or stamp steps, and funding stays as it is today,
by hand, with no manager wallet. His words on the endpoint: "Our RPC endpoint, never the public one silently."

## What already existed, so nothing was built twice

- A deployment's endpoint was already a column, `profiles.rpc_endpoint` (migration 032), validated by
  `rpcEndpointProblem` in `common/src/publishUrl.ts`, written into the deployment's env file as
  `RPC_ENDPOINT` by `writeProfileEnv` and editable after creation in the edit drawer. The wizard never sent it.
- The stack's compose already read `RPC_ENDPOINT` for the four publisher services. The gateway service
  ignored it: its endpoint was an empty literal, which is what makes it ultra-light.
- `ownsBeeNode(profile)` in `common/src/stampGating.ts` was the single test behind the funding and stamp
  steps of the readiness checklist. A viewer gateway already got neither step.

## The stack half (Solar-Punk-Ltd/swarm-hls-stream, branch `feat/bee-node-mode` off main-v3)

1. The gateway's two chain flags in `deploy/docker-compose.yml` become variables whose defaults are today's
   literals: `--blockchain-rpc-endpoint=${BEE_GATEWAY_RPC_ENDPOINT:-}` and
   `--swap-enable=${BEE_GATEWAY_SWAP_ENABLE:-false}`. Full node stays `false`. A deployment that sets nothing
   gets the ultra-light gateway it always got.
2. `deploy/test/beeRpcHost.test.js` changes from "the gateway's flags are literals" to "the gateway's defaults
   are ultra-light", which keeps the purpose of the ruling of 2026-09-15 (no gateway becomes light by
   accident) and drops its mechanism (no setting can reach it). The compose comment says the older ruling is
   superseded and by what.
3. The publisher services do not change. A publisher is light by definition and the manager refuses
   ultra-light for one.

## The common and manager half (this repository, main-v2), as built

1. **Storage.** Migration 035 adds `profiles.node_mode`, nullable, `light` or `ultra-light`, where null means
   "as the stack ships that node": light for a profile that owns a `bee-uploader`, ultra-light for one whose
   node is a `bee-gateway`. No backfill, so an existing deployment reads right without a data fix. It also
   adds `rpc_endpoint_source`, `manager`, `stack` or `custom`, default `stack`, backfilled to `custom` where a
   URL was stored, with a CHECK that `custom` and a stored URL go together and only together.
2. **The shared rules**, in `common/src/nodeMode.ts` and `common/src/rpcEndpointSource.ts`: `effectiveNodeMode`
   answers the mode for every reader, `nodeModeProblem` refuses an ultra-light publisher with "an ultra-light
   node cannot upload", `rpcEndpointChoiceProblem` refuses a custom source without a valid address, an address
   on any other source, the manager's source when the manager has no endpoint, and the stack's source for a
   light gateway, because the stack's default for a gateway is no endpoint at all. `impliedRpcEndpointSource`
   says what a create means when it names no source (an address is custom, else the manager's when configured,
   else the stack's) and `keptRpcEndpointSource` what an edit means (the stored choice survives an edit about
   something else, and an address arriving or leaving moves the choice with it).
3. **The manager's own endpoint.** `BEE_RPC_ENDPOINT` in the manager's env, one URL, optional, validated at
   startup. `GET /config` answers `beeRpcEndpoint: { configured, host }`, the host and nothing after it,
   because a URL that carries a key is a secret.
4. **The API.** `node_mode` on create only, an edit that changes it is refused. `rpc_endpoint_source` and
   `rpc_endpoint` on create and edit. `POST /groups` takes the same three for every member of a pool, one
   answer for the whole group, because rungs reaching the chain through different endpoints fail as one rung
   quietly not publishing.
5. **The env file.** `writeProfileEnv` resolves the source: `manager` writes the configured URL as
   `RPC_ENDPOINT`, `custom` the deployment's own, `stack` no line. A source that names a value and finds none
   stops the deploy with the variable named rather than falling to the public endpoint in silence. A light
   gateway also gets `BEE_GATEWAY_RPC_ENDPOINT` and `BEE_GATEWAY_SWAP_ENABLE=true`. The gateway's container
   key list carries those two and no longer lists `RPC_ENDPOINT`, which the gateway's compose never read.

## The frontend half

1. The wizard's `beeMode` (own node or external node) is renamed `beeChoice` first, so the new `nodeMode`
   cannot be misread. The stack's own `beeMode` is bee's word for light or ultra-light.
2. A stream's own node and a pool member show a fixed line, "Light node, required to publish", and the endpoint
   choice. The viewer gateway offers the mode, ultra-light by default, and the endpoint choice when light is
   chosen. A custom deployment follows its ticked components. The endpoint choice has three sources: the
   manager's endpoint, preselected whenever one is configured, the stack's default labelled as public and rate
   limited, and a URL typed in. The review step lists both. Submit sends the source explicitly.
3. The checklist keeps its rule, funding and stamp steps for a node that publishes, and states it through the
   shared mode function. The configuration card shows the mode and the endpoint as source and host. The edit
   drawer edits the endpoint source and shows the mode read-only. The offline mock mirrors the API.

## Implementation choices, settled 2026-09-17

Levi ruled the same morning that the four points below were the session's to decide ("what I thought you
have done these"), and they were taken as recommended:

1. **A light viewer gateway supersedes the ruling of 2026-09-15** that a viewer node is always ultra-light and
   can only be changed by editing the compose file. T27, ruled two days later, offers the choice with
   ultra-light as the default, so the flags become settings and the test guards the defaults. Not built in
   this row: the funding readings of a light gateway, whose wallet and chequebook are read today only for a
   publisher's node.
2. **A publisher's mode is a line, not a choice.** The row says every step offers the mode and a publisher set
   to ultra-light is refused. For a stream's own node and a pool member that would be a control with one
   allowed value, so those steps show "Light node, required to publish" and the real choice appears on the
   viewer gateway and on a custom deployment. The API refuses an ultra-light publisher all the same.
3. **The manager's own endpoint is one new setting**, `BEE_RPC_ENDPOINT`, rather than the first entry of
   `CHEQUEBOOK_RPC_ENDPOINTS`, which is a list the chequebook watcher reads the chain through, a different job.
4. **The mode is chosen at creation only.** Switching a running node's mode changes what its data directory
   and its chequebook mean and is at least a redeploy, so an edit that changes it is refused and the drawer
   shows it read-only. Editable with a redeploy is a follow-up if it is ever asked for.

## Order

1. Common and manager half, one Opus lane, tests first, on main-v2. Landed.
2. Frontend half, a second Opus lane after the common rules landed, tests first.
3. Stack half on its branch off main-v3, pushed, box at standard depth, merged fast-forward on Levi's word and
   pinned here, because the manager writes two keys nothing reads until then. A light gateway created before
   that pin starts ultra-light in practice.
4. Correctness and security reviews of each half, then the box deep on the session branch, then Levi's push of
   main-v2 and deploy.

## Acceptance, as the row states it

- Creating a viewer gateway in ultra-light mode starts a node that never asks for gas, and its readiness shows
  no funding step.
- Creating a pool member in light mode starts a node whose RPC endpoint is the manager's, and the funding step
  shows the node's address and the gas it asks for.
- Added here: the node's page names the mode and the endpoint's host, and a viewer gateway created before this
  row still reads ultra-light.

## Out of scope, on the row's own word

Sending gas or BZZ from the manager, a manager-held wallet, changing a node's mode after creation, the rung
nodes' modes (a rung publishes), and the wallet readings of a light gateway.
