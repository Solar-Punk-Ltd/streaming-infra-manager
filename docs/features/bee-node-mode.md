# A Bee node's mode and its RPC endpoint

A Bee node runs in one of two modes. A light node talks to the Gnosis chain
through an RPC endpoint, deploys a chequebook on its first start, needs gas in
xDAI and BZZ for its chequebook and its stamps, and can publish. An ultra-light
node has no chain, no chequebook and no gas, and can only download. In bee's own
terms ultra-light is a node with no RPC endpoint that is not a full node, and the
SWAP switch takes no part in that.

Status, 2026-09-17. Row T27 of `docs/consensus/issues/`, ruled by Levi that
day: the mode and the endpoint are chosen when a node is created, the node's
page shows both, an ultra-light node has no funding or stamp steps, and funding
stays as it is, by hand, with no wallet held by the manager. The manager and
frontend halves are on `main-v2`, reviewed and fixed the same day (the brief and
the fixes file are under `docs/consensus/`). The stack half was merged into the
manager's line of the stack, `feat/manager-line`, at 5553652c and pinned the
same day, so a gateway created light is light once that pin is deployed. Until
the host runs that pin, its choice is recorded and written but read by nothing. Written at
`b56ae6f` on `main-v2` with the stack pinned at `55b22bf1`, and re-read on the evening of
2026-09-17 in the docs and comment review, with the stack pinned at `52164ebf`, the head of
`feat/manager-line` after that review's 42 stack commits.

## What the stack ships

The stack's compose file gives every publisher node, the stream's own node and
the three rung nodes, a chain endpoint read from `RPC_ENDPOINT`, with the public
`https://rpc.gnosischain.com` as its default, and SWAP on. That endpoint took
4568 refusals in two hours on 2026-09-15, which is why the manager offers its
own first. The viewer gateway ships ultra-light: no endpoint and SWAP off, and
since T27 those two are settings, `BEE_GATEWAY_RPC_ENDPOINT` and
`BEE_GATEWAY_SWAP_ENABLE`, whose defaults are the old literals (stack commits
75f9b1e1, 251bb1c1 and 5553652c on `feat/manager-line`, the rendered gateway
with neither key measured byte-identical to the one before). A deployment
that sets neither gets the gateway it always got, and a test in the stack's
deploy suite holds the defaults there. That supersedes the ruling of 2026-09-15
that a viewer node is always ultra-light and can only be changed by editing the
file: the default is unchanged and the operator now has the choice.

## What the manager stores

Two columns on a deployment, migration 035. `node_mode` is `light`,
`ultra-light` or empty, and empty means "as the stack ships that node": light for
a deployment that owns a publisher node, ultra-light for one whose node is the
viewer gateway. Every existing deployment therefore reads right without a data
fix. `rpc_endpoint_source` is `manager`, `stack` or `custom`, and the deployment's
`rpc_endpoint` URL is set exactly when the source is `custom`. Existing
deployments with a URL became `custom` and the rest `stack`, which is what they
were running.

Status, 2026-09-19, based on `a5b4253` and fixed on
`fix/main-v2-rpc-privacy`: a custom URL is private deployment input. Profile
responses and deployment events expose only `has_rpc_endpoint` and
`rpc_endpoint_host`. The host contains no userinfo, path, query or fragment.
The database projection treats a backslash after an HTTP host as a path
boundary, matching the URL parser instead of returning the path as part of the
public host metadata.
The repository reads the full URL separately only for endpoint redaction and
for a claimed deployment that is about to write its env file.

An edit page starts its custom endpoint field empty. Leaving an existing custom
choice unchanged omits the URL from the request and preserves the stored URL.
Typing a replacement sends that replacement. Choosing the manager or stack
source clears the stored custom URL, including when an API client sends only
the replacement source.

The shared rules live in `common`: `effectiveNodeMode` answers the mode for
every reader, `nodeModeProblem` refuses an ultra-light publisher with "an
ultra-light node cannot upload", and `rpcEndpointChoiceProblem` refuses the
source and URL combinations that cannot work: `custom` without a valid URL,
`manager` when the manager has no endpoint, and `stack` for a light gateway,
because the stack's default for a gateway is no endpoint at all.

## The manager's own endpoint

`BEE_RPC_ENDPOINT` in the manager's env is one URL, optional, validated when the
manager starts. `GET /config` reports whether it is configured and its host, the
host and nothing after it, because an endpoint that carries a key in its
userinfo or its path is a secret. The URL itself reaches a node only through the
deployment's env file, mode 600, and is never logged. A keyed endpoint belongs
in the host's env as a 1Password reference.

When a deployment starts, the manager resolves the source: `manager` writes its
configured URL as `RPC_ENDPOINT`, `custom` writes the deployment's own URL, and
`stack` writes no line. For a light gateway it also writes the two gateway
settings above.

## What the wizard offers

A stream's own node and a pool member show one line, "Light node, required to
publish", and the endpoint choice. The viewer gateway offers the mode,
ultra-light by default, and the endpoint choice when light is chosen. A custom
deployment follows its ticked components. The endpoint choice has three
sources: the manager's endpoint, preselected whenever one is configured, the
stack's default, labelled as the public endpoint and rate limited, and a URL
typed in. The review step lists both, and the mode cannot be changed after
creation, because switching a running node's mode changes what its data
directory and its chequebook mean.

## What the page shows

The configuration card of any deployment that owns a node names the mode,
"Light, on the chain" or "Ultra-light, download only", and the endpoint as its
source and host, or "None, an ultra-light node reaches no chain" for a node
that runs no chain. The edit drawer offers the same three sources, and going
back to the stack's endpoint is a choice made there, not an emptied box. The
mode is read-only after creation. The readiness checklist keeps its rule: the funding and stamp
steps belong to a node that publishes, which is always light, so an ultra-light
gateway has neither. The wallet and chequebook of a light gateway are not read
by the manager in this row.

## Verified

Common 405, manager unit 2666, manager database 540 on a disposable Postgres,
frontend unit 311 and browser 259 through the laptop lane on 2026-09-17, with
a browser walkthrough that creates a viewer gateway in each mode and a stream
on the manager's endpoint against the offline mock and reads both entries off
each page and the stored profile back. The stack's deploy suite is 889 on its
branch, where the rendered gateway with neither key was measured byte for
byte identical to the one before. Two read-only reviews of the manager half,
one for correctness and one for security, and one of the frontend half. A
light gateway's chequebook coming up through the two keys is proved on the
rendered compose command, not on a running Bee node.

The 2026-09-19 privacy regression ran focused manager service, SQL projection,
deployment env and log redaction tests, plus frontend edit and offline manager
tests. The red and green evidence and the unrun database limit are recorded in
`docs/testing/rpc-endpoint-privacy.md`.
