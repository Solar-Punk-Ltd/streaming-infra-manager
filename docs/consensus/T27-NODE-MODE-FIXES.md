# T27 fixes: what the reviews of the manager half found, and what changed

Status: active, 2026-09-17. Companion to `T27-NODE-MODE-BRIEF.md`. Three read-only reviews on `main-v2`: one
for correctness and one for security of the manager half (`1c26203` to `1c8fc25`), and one of the frontend half
(`08bc01e` to `335b6fb`). Priorities on the estate's scale. The manager fixes landed as `9b07e56`, `adcbb29`,
`df04f84`, `ce9f362`, `9a9aad9`, `5ff3e48`, `b1f823f` and `b56ae6f`, the frontend fixes as `e1447dc`, `dd4ced2` and `0361a33`.

## P1, fixed. The endpoint URL reaches pages and stored output through Bee's own log

Bee prints its `--blockchain-rpc-endpoint` value into its own log on every start and again, whole, when it
cannot reach the chain. The manager serves that container log to the browser through the logs route, and on a
failed start the stack's `assert-started.sh` echoes the container's last lines to stderr, which the orchestrator
keeps as the failure text, writes to `profiles.last_error`, publishes over `/events` and prints with a warning.
So a keyed endpoint, the manager's or a custom one, reached a page and the database in plain text, against the
row's sentence "never printed in logs or pages". The host-only care at `GET /config` held and was not enough.

Fixed two ways. The manager redacts every known endpoint URL (its own and the deployment's custom one) to its
host in the two places it hands text it did not write on: the stdout and stderr tails before the failure text
is built, so `last_error`, the events stream and the manager's log carry the host only, and the container logs
route. And the docs tell the truth: Bee prints the value into its container log on the host, which `docker
logs` shows to anyone with docker access there, and the command line of every node shows it in the host's
process table, so the safe shape for `BEE_RPC_ENDPOINT` is a keyless address such as a proxy on the host that
holds the key. Not pursued: passing the endpoint to Bee as an environment variable instead of a flag, which
would move it from the process table to `docker inspect` only, while Bee's own log prints it at every start.

## P1, fixed. A `$` in a stored address expands on a remote deploy target

`rpcEndpointProblem` accepted `https://evil.example/${STREAM_KEY}`. The value is written verbatim into the
deployment's env file, and on a remote deploy target Compose expands `${...}` inside an env-file value from keys
parsed earlier in the same file, so `${STREAM_KEY}`, `${API_AUTH_TOKEN}` and `${PUBLISH_KEY_SECRET}` from the
base env resolve into the URL Bee posts to. A local deploy was defused by accident: the deploy script exports
the file literally before Compose runs, and Compose keeps a key the shell already has. Pre-existing since
migration 032 for a custom address, made first-class by this row. The actor is a signed-in operator and the
path needs a deployment on another host, which the live host does not use today. Fixed at the address shape
rule: a `$` anywhere in an address is refused with a fixed message, which covers the custom address, the
external node URL, `BEE_RPC_ENDPOINT` at startup and both gateway keys at once. A provider URL with a key in
its path is still accepted.

## P2, fixed. An ultra-light node created without a source was put on the manager's endpoint

The implied source for a create that names none answered `manager` whenever the manager has an endpoint,
without looking at the node's mode, and the wizard sends no source for an ultra-light viewer by design. So the
keyed URL was written into the env file of a node whose gateway never reads it (and rsynced to a remote viewer
host), the page said the node takes the manager's endpoint, and the day `BEE_RPC_ENDPOINT` is removed that
node's redeploy would have been refused for an endpoint it never needed. Fixed in the shared rule: an
ultra-light node implies the stack's source.

## P2, fixed. Emptying a custom address moved a deployment onto the public endpoint

The kept source for an edit that drops the address answered `stack` whatever the manager has, so an edit
landed a publisher on the throttled public endpoint without a word, against "our RPC endpoint, never the
public one silently". Fixed in the shared rule: when the address goes, the node falls back to the manager's
endpoint when the manager has one and the node is light, else the stack's. The SQL that repeated the rule
agrees or is gone.

## P2 once the stack half lands, built now. An ultra-light gateway states its mode both ways

An ultra-light gateway's env file stated neither gateway key, and the file is a full copy of the version's base
env, so once the stack's compose reads `${BEE_GATEWAY_SWAP_ENABLE:-false}` a host-wide value written into the
base env would have turned every ultra-light gateway light on its next deploy. The writer now states
`BEE_GATEWAY_SWAP_ENABLE=false` and an empty `BEE_GATEWAY_RPC_ENDPOINT=` for an ultra-light gateway, the same
trap `LOCAL_BEE_UPLOADER` already names.

## P3, documented and stopped

- The container snapshot never carries the resolved endpoint or the two gateway keys. Nothing reads that
  column, and adding the resolved URL would put a keyed value into the database. Left as it is on purpose.
  Reproduce: deploy a light gateway and read `containers.env` for `bee-gateway`.
- A rollback to code before `fda0878` with migration 035 applied needs the pairing constraint dropped first.
  The migration header says so.
- A pool member's source and address can be changed one member at a time after creation, so "one answer for
  the whole group" holds at creation only. Reproduce: `PUT /profiles/<member>` with `rpc_endpoint_source: stack`.
- The host alone can identify a provider account when the provider issues a unique subdomain. The env sample
  says so.
- The address rule refuses any userinfo with a message written for ssh targets, so a basic-auth endpoint
  cannot be configured at all. The comments no longer claim a key may sit in the userinfo.
- The address rule accepts private and link-local hosts, so a custom endpoint is an SSRF shape from the Bee
  container, the same shape `bee_url` has had since it existed. Reproduce: `rpc_endpoint: http://169.254.169.254/`.
- Two endpoint settings coexist: `BEE_RPC_ENDPOINT` for nodes and `CHEQUEBOOK_RPC_ENDPOINTS` for the
  chequebook watcher. The env sample says the second does not follow the first.

## Tests the reviews found missing, added

Router-level tests that the three fields travel from the body to the service on `POST /profiles`,
`PUT /profiles/:name` and `POST /groups`. `GET /profiles` and `GET /profiles/:name` return both fields. The
orchestrator's own env-file call writes a byte-identical file for an existing deployment. The edit refusal
when the manager has lost its endpoint and the deployment takes it.

## The frontend half, reviewed the same day

Nothing at P1: no page or log shows a full endpoint URL other than the address the operator typed in the two
custom boxes, no body sends anything but the three named fields, and the form asks the shared rules with the
same inputs the manager's schema asks them with, the pool judged as one `bee-uploader` per member on both sides.

- **P2, fixed.** The light mode's label read "Light, publishes" on the card and the drawer of every deployment
  that owns a node, a viewer's gateway included, and a light gateway pays for its downloads through a
  chequebook rather than publishing. The brief's own wording. It is now "Light, on the chain".
- **P2, fixed.** The two lines that reduce a custom URL to its host on the page and in the review step had no
  test through them. The browser walkthrough now creates a custom-endpoint deployment and asserts the host is
  shown and the path is not.
- **P3, fixed in passing.** The field was "Chain endpoint" in the wizard and the drawer and "RPC endpoint" on
  the card and in the docs. It is "RPC endpoint" everywhere. Two toothless tests were tightened.
- **P3, documented.** A light gateway on a manager with no endpoint opens with "Stack default" checked and
  disabled, the refusal in its detail, until Custom is picked. A failed `/config` read at boot reads as "no
  endpoint configured" for that session, and the wizard opens only from clicks made long after. The form reads
  the manager's endpoint once at boot and the manager reads its env per request, so they disagree only across
  a restart with a changed env, and then the API's refusal is shown. The mode-change refusal sentence is a
  literal in the mock and in the manager with no shared constant.

## Checked and found sound by both reviews

The migration (transactional, backfill, both CHECKs exercised by the database suite), every INSERT and UPDATE
parameterized, the pairing constraint unreachable through the service, the mode change refused on every
update path, no route's access rules changed, `BEE_RPC_ENDPOINT` never in the database, an API answer or a
manager log line beyond its host, the env file at mode 0600, env-file injection through newlines refused for
every key, and an existing deployment writing a byte-identical env file on its next deploy.
