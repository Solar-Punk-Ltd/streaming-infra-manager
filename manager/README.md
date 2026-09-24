# Manager API

Thin TypeScript backend that runs the `swarm-hls-stream` deploy scripts on
demand and tracks each profile's `port_slot` in PostgreSQL so two profiles
on the same host can never collide on a port.

## Stack

- **Express 5** + ESM + **TypeScript**
- **PostgreSQL 16**, the single source of truth for `port_slot` allocations (1 to 100)
- **Yup**, request body and params validation at the API edge
- **dotenv**, config from `.env`
- **Docker-out-of-Docker**: the API container spawns `bash deploy.sh ...`,
  which calls `docker compose` against the host daemon via a mounted
  `/var/run/docker.sock`

## Quick start (one host, "localhost" deploys)

```bash
cp manager/.env.sample manager/.env
cd manager
docker compose up --build -d
curl localhost:8080/health                      # {"status":"ok"}
docker compose exec -it api node dist/cli.js user:add <username>
```

That is the web container's port, `WEB_PORT`, 8080 by default, because the api
container publishes no port of its own and the web container's nginx forwards
`/health` and the rest of the API to it. Under `pnpm dev` the API answers on
`localhost:9876` directly, which is what the curl examples further down assume.

Until that last command has been run once, every route but `/health` and
`POST /auth/login` answers 401, and the sign-in page says so.

## Authentication

Every route needs a session except two: `GET /health`, which answers
`{"status":"ok"}` and nothing more, and `POST /auth/login`. That includes both
Server-Sent Events streams, `/config`, `/metrics` and `/profiles`.

No Docker healthcheck reads `/health`, as of 2026-09-23 at `87673c99`: the
`api` service in `docker-compose.yml` has none and neither Dockerfile declares
one. Its readers are `manager:upgrade`, which `deploy/deploy.sh` runs and which
waits for the new api to answer it, the integration suite, whose preflight asks
it and whose CI job in `.github/workflows/docker-checks.yml` waits for it
first, and the curl in the quick start above.

### The first user

There is no sign-up. The first user is created on the host, once:

```bash
docker compose exec -it api node dist/cli.js user:add levi
```

It asks for the password twice with nothing echoed, and writes only the hash.
Without a terminal it refuses, unless `--password-stdin` is given, which reads
the password from a pipe so a vault can supply it without the value landing in
a file or an argument:

```bash
op read "op://<vault>/<item>/password" | \
  docker compose exec -T api node dist/cli.js user:add levi --password-stdin
```

There is deliberately no environment variable and no seed file that carries a
password. A password is 12 to 128 characters and must not contain the username.
It is stored as `scrypt$N$r$p$<salt>$<key>`, so the cost parameters can be
raised later without invalidating the passwords already set.

### The session

Signing in sets `sim_session=<token>; HttpOnly; SameSite=Lax; Path=/`, plus
`Secure` when the browser reached the manager over HTTPS and only then. That is
read from the request: `X-Forwarded-Proto: https` from the TLS edge, which
nginx forwards, or a TLS connection to the manager itself. Over the plain HTTP
of the SSH tunnel it is left off, because a browser drops a `Secure` cookie
that did not arrive over TLS and the sign-in would loop.

The token is 32 random bytes. The database stores only its SHA-256, so a dump of
the sessions table signs nobody in. A session ends after twelve hours of
inactivity, and fourteen days after it started whatever happens in between.
Session admission and password replacement recheck the password hash while
holding the same user row lock. A login or second replacement that verified an
older hash cannot create a session or overwrite the newer password.

Signing out, revoking a user's sessions, removing a user or changing a password
also closes that session's open event and command streams at once, so a browser
stops receiving profile events, command output or version build output the
moment it stops being signed in. Closing an output stream does not cancel an
accepted deploy, stop or version build. A health check is stopped when its
stream closes because its result has no caller left. A session that runs out
rather than being revoked has its streams closed within a minute, and a stream
is not activity, so a page left open with nothing but its streams still idles
out after twelve hours.

Five wrong passwords for a username, or from one address, start a one minute
lockout that doubles per further attempt up to an hour, answered as 429 with
`Retry-After`. Every failure is logged with the username and the address.

Every request that is not a GET must carry the header
`X-Requested-With: streaming-infra-manager`, and one whose `Origin` or
`Sec-Fetch-Site` says it came from another site is refused with 403. The
manager sets no CORS headers, which is what makes that header impossible for a
cross-origin page to add.

### Endpoints

| Method | Path | Body | Answer |
| ------ | ---- | ---- | ------ |
| POST | `/auth/login` | `{ username, password }` | 204 and the cookie, 401 wrong pair, 429 locked, 409 when no user exists |
| POST | `/auth/logout` | | 204, cookie cleared, session row deleted |
| GET | `/auth/session` | | `{ id, username, isAdmin, expiresAt }`, or 401 with `not_signed_in` or `no_users` |
| POST | `/auth/password` | `{ current, next }` | 204, every other session of yours revoked |
| GET | `/auth/users` | | `[{ id, username, isAdmin, createdAt, lastLoginAt, sessions }]` |
| POST | `/auth/users` | `{ username, password, admin? }` | 201 and the new user's row, 403 `admin_required` unless you are an admin, 409 taken |
| DELETE | `/auth/users/:id` | | 204, 403 `admin_required` unless you are an admin, 404 no such user, 409 for yourself, the last user or the last admin |
| POST | `/auth/users/:id/revoke-sessions` | | 204 for your own id, and for anyone's if you are an admin, otherwise 403 `admin_required`. 404 no such user |

Adding a user, removing one and signing someone else out need an admin, and
nothing else does. Who is an admin and how a user becomes one is the paragraph
"Who can manage users" under
[Endpoints](../docs/features/auth-and-public-access.md#endpoints) on the auth
page. Checked against the code at `87673c99` on 2026-09-23.

## API

All command endpoints stream output as Server-Sent Events
(`start` / `stdout` / `stderr` / `error` / `done`). Use `curl -N` to follow.

### Profiles

| Method | Path              | Body                                              | Notes                                                         |
| ------ | ----------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/profiles`       | see below                                         | Allocates lowest free `port_slot` (1–100), seeds from `.env`. |
| GET    | `/profiles`       | none                                              | List ordered by `port_slot`.                                  |
| GET    | `/profiles/:name` | none                                              | Single profile.                                               |
| DELETE | `/profiles/:name` | none                                              | Releases the slot.                                            |
| PUT    | `/profiles/:name` | the editable fields                               | Full edit. 202 and the profile.                               |
| PATCH  | `/profiles/:name/notes` | `{ notes, revision }`                       | Notes alone, without a redeploy.                              |
| GET    | `/profiles/:name/srt-passphrase` | none | `{ srt_passphrase }`, `no-store`. The deployment's own SRT passphrase, which the row no longer carries. Every read is logged with the signed-in user's name. |
| GET    | `/profiles/:name/uploader-health` | none | `{ state, reasons, waitingSince?, node?, startGateWarnings? }`. What this deployment's own `stream-uploader` says about itself, read off its API port. `state` is one of `ok`, `waiting_for_node`, `warned`, `unhealthy`, `unreachable` or `not_deployed`. |

`POST /profiles` takes `name` and `kind`, one of `streamer`, `viewer`, `custom`
or `abr-uploader`. Everything else is optional: `components`, `host`, `notes`,
`stack_version_id`, `feed_owner`, `feed_topic`, `private_key`, `public_key`,
`stamp_id`, `srt_passphrase`, `bee_url`, `bee_publishers`, `rpc_endpoint`,
`rpc_endpoint_source`, `node_mode` and `engine_settings`. `abr_ladder` belongs
to `POST /groups`, where it makes the group an ABR node pool, and a create body
carrying it is refused. `manager/src/schemas/profile.ts` is the whole contract
and its rules are the ones the route enforces.

`GET /profiles/:name/uploader-health` is read by the deployment page and by
nothing else, because a list would have to ask every uploader in turn. Decision
D16 of 2026-09-17 lets an uploader start on a Bee node that is not answering, so
a running container stopped meaning a working one: the uploader waits for that
node and reports the wait on its own `/health`, which this route reads on the
uploader's API port for the deployment's port slot, under a three second budget.
It never fails for a reading. Nothing answering is `unreachable`, a deployment
with no uploader container is `not_deployed`, a start gate that warned instead of
refusing is `warned`, and a stack older than D16 reports none of the new fields
and so reads as `ok` or `unhealthy` on its own status alone.

The deployment checklist renders that health step for a single-node stream and
for a pool-backed `abr-uploader`. An ABR uploader puts its pool configuration
first and needs no single-node stamp or funding check of its own. Once the pool
string is usable, the same waiting, warned, unhealthy and healthy readings are
shown from the uploader's route.

`engine_settings` is create-only and `POST /groups` takes it on the same terms,
writing it to every member of the group, because a deployment is `DEPLOYING`
from the moment create returns and the settings route refuses a busy one. It is
held to the rule the settings drawer applies, so a deployment that runs no media
server, an ABR node pool among them, is refused rather than storing keys nothing
would read.

`rpc_endpoint` is the chain endpoint this deployment's own Bee nodes use, and
empty means the one its stack version carries. It exists because the stack's
shipped default is a public RPC, and one node on it drew 4568 HTTP 429s in two
hours on 2026-09-15, which is a rate limit rather than a fault anybody could see
from the manager.

`rpc_endpoint_source` says where that endpoint comes from: `manager` is this
manager's own `BEE_RPC_ENDPOINT`, `stack` is the version's default and writes no
line into the deployment's env file, and `custom` is the address in
`rpc_endpoint`. `custom` and a stored address go together and only together, a
create that names no source takes the manager's endpoint when there is one, and
an address arriving with no source is read as a custom one, which is what this
API took before the field existed. An update that names no source keeps the
stored choice unless the address it belongs to went with the same body.

`POST /groups` takes `node_mode`, `rpc_endpoint_source` and `rpc_endpoint` on
the same terms as `engine_settings`, one answer written to every member, and
holds them to the same rules over the services the members are actually given.
A node pool's members are one Bee node each whatever the body's `components`
say, so a pool asked for `ultra-light` is refused rather than created as nodes
that cannot upload, and a member appended to a group later takes what its
siblings run rather than being asked again.

`node_mode` is how much of a chain this deployment's Bee node runs with:
`light` has a chequebook, gas and postage and can publish, `ultra-light` has no
chain at all and can only retrieve. Empty is the mode the stack ships that node
in, light for a `bee-uploader` and ultra-light for a `bee-gateway`, which is
what every deployment made before 2026-09-17 runs. It is chosen when the
deployment is created, which is Levi's ruling of 2026-09-17, so an update
carrying a different mode is refused rather than applied. A `bee-uploader`
asked to run ultra-light is refused outright, and a `bee-gateway` put on
`light` has to name an endpoint, because the stack's default for a gateway is
no endpoint at all.

Every profile in a response carries derived fields beside its stored columns.
One of them is `network_host`: the deploy target in `host` with the ssh layer
resolved away, so a client has an address to build links from rather than an
alias only the manager's ssh config can read. It equals `host` when there is
nothing to resolve.

### Actions (per profile, SSE)

| Method | Path                     | Body                      | Maps to                                                |
| ------ | ------------------------ | ------------------------- | ------------------------------------------------------ |
| POST   | `/profiles/:name/deploy` | `{ services?: string[] }` | `deploy.sh --profile=<name> --portSlot=<n> [services]` |
| POST   | `/profiles/:name/stop`   | `{ services?: string[] }` | `stop.sh   --profile=<name> --portSlot=<n> [services]` |
| GET    | `/profiles/:name/health` | none                      | `health.sh --profile=<name> --portSlot=<n>`            |

When `services` is omitted:

- `streamer` → `srs stream-uploader bee-uploader`
- `viewer` → `client bee-gateway`
- `abr-uploader` → `srs stream-uploader`, and no Bee node: it publishes to an
  ABR node pool's rungs, which hold the postage
- `custom` → empty (the script then uses everything enabled in `config.json`)

Media engines: `srs` (default) and `ome` are mutually exclusive, so a profile's
`components` may contain at most one of them. Including `ome` makes the manager
write `ENGINE=ome` (plus slot-shifted `OME_SRT_PORT`/`OME_HLS_PORT`) into the
profile's `.env.<name>` so the stream-uploader runs the OvenMediaEngine plugin.

SRT passphrase: a profile may carry its own `srt_passphrase`, written to
`.env.<name>` as `SRT_PASSPHRASE` so SRS encrypts that deployment's SRT listener
with it. Left unset, the base `.env`'s host-wide value applies, which is the
behaviour before the field existed. This is SRS only. OME's SRT listener takes
no passphrase. Accepted values are 10 to 79 characters of
`A-Z a-z 0-9 . _ ~ -`. The bounds are
libsrt's and the character set keeps the value intact through the `sed` in
`engines/srs/entrypoint.sh`, the env file, the srs.conf directive and the
`srt://…&passphrase=` publish URL (see `common/src/srtPassphrase.ts`).

A deploy takes minutes, so a manager restarted in the middle of one is ordinary.
Every deployment still recorded as `DEPLOYING`, `STOPPING` or `REMOVING` at boot
is judged by what its services are doing on the target, and a service counts as
up when at least one of its containers is running. A deploy or a removal that
left every service up becomes `RUNNING`, and one that did not becomes `ERROR`
naming each service that is not up and the state Docker has for it, while a stop
becomes `STOPPED` when nothing is up and `ERROR` naming what is still running
otherwise. A daemon that cannot be reached leaves the row `ERROR` saying so.

### Why the uploader is held back

A postage stamp is prepaid Swarm storage, bought on a running, funded Bee node.
Only `stream-uploader` needs one. A viewer never does, and neither does a
deployment that is nothing but a Bee node.

The stack refuses to bring up a `stream-uploader` whose env file has neither a
`STAMP` nor a `BEE_PUBLISHERS` value, in `check_stamp` in its own `deploy.sh`.
Under the manager there is no terminal to ask, so that refusal is final and the
script exits non zero. The manager therefore never sends a deploy into it.
Instead it splits the service list (`splitDeployableServices` in
`manager/src/domain/stampLogic.ts`):

- No `stream-uploader` in the set, so the guard never fires. Deploy everything.
- `stream-uploader` with a `stamp_id` or a `bee_publishers` value. Deploy
  everything, and write `STAMP` into `.env.<profile>` so the guard reads it.
- `stream-uploader` with neither. Deploy the set **minus** `stream-uploader`.

The last case is the point. The rest of the deployment comes up, the Bee node
runs, and a batch can be bought on it, which is impossible if the deploy failed
as a whole. The profile still reads `RUNNING`, because it is, minus the
uploader, and a derived `pendingStamp` field carries the difference rather than
a new status. Once a batch exists,
`POST /profiles/:name/deploy-uploader` deploys that one service.

The test is the component set, never the kind: a `custom` deployment that
includes `stream-uploader` behaves exactly like a `streamer`. A pool-backed
`abr-uploader` is the exception in the other direction. Its postage is the
pool's, one batch per rung, so `BEE_PUBLISHERS` satisfies the guard and nothing
is held back.

### Chequebook (per profile, its own bee node)

A bee node pays the peers that forward its uploads with cheques drawn on a
chequebook, a contract on Gnosis Chain holding BZZ. It is a different pot from
the node's wallet: the wallet holds xDAI for gas and BZZ for buying stamps and
for topping the chequebook up. When the chequebook runs dry nothing looks
broken, the node stays healthy and every push stalls waiting for a payment it
cannot make.

| Method | Path                                  | Body                    | Notes                                                                             |
| ------ | ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| GET    | `/profiles/:name/chequebook`          |                         | Address, balances, settlement totals and the health verdict. Any field is `null` when that call to the node failed. |
| POST   | `/profiles/:name/chequebook/deposit`  | `{ requestId, profileInstanceId, amount, expectedAccountId }` | Wallet to chequebook. `202` with the recorded operation, or `409` with the operation in the way. The body is strict, so a missing or unknown field is refused with 400 before any balance is read, and an `expectedAccountId` that is not the signed-in user is refused with `409 account_changed`. Also refused with 400 when the wallet holds less BZZ than asked or has no xDAI for gas. The whole contract, including recovery, is under "API contract" in [docs/features/chequebook.md](../docs/features/chequebook.md). |
| POST   | `/profiles/:name/chequebook/withdraw` | `{ requestId, profileInstanceId, amount, expectedAccountId }` | Chequebook to wallet, the same body and the same answers. Also refused with 400 above the available balance. |

`amount` is PLUR, bee's integer unit, matching `^[1-9][0-9]*$` and at most 30
digits. 1 BZZ is 10^16 PLUR, so a decimal here is refused rather than
interpreted. `common/src/chequebook.ts` converts.

Both writes answer as soon as bee has submitted the transaction, not once it is
mined, so the balance moves a few Gnosis blocks later. Poll the GET to see it.

**The chequebook never refuses an uploader start**, on the owner's ruling of
2026-09-17. The gate reads the node and writes what it found in the log, a node
that did not answer, a balance that cannot be parsed, and a balance under the
floor with both numbers in it, and the start proceeds in every case. An operator
who wants an uploader up on an unfunded node gets it up, and what that costs is
uploads that stall, which the deployment page shows from the uploader's own
health rather than leaving to be guessed at. `409 chequebook_unfunded` is
therefore gone: no route answers it, no error class carries it, and the offline
mock no longer refuses a start on funding either.

The one check that still refuses is the batch, and only on an answer the node
gave: one it calls unknown, expired or not usable yet. A node that could not be
asked never refuses either check, because a failed probe is no evidence about a
chequebook or about a batch. The uploader then waits for a node that never
answered rather than exiting, and `GET /profiles/:name/uploader-health` is where
that wait is read.

**`CHEQUEBOOK_FLOOR_BZZ`** sets that floor, default `0.5`. It is a decimal BZZ
amount above zero with at most 16 decimal places, parsed once at startup, and a
malformed value stops the process rather than silently reverting to the default.
`GET /config` answers it as `chequebookFloorBzz` so the UI shows the number the
gate uses.

Two more process settings decide whether a transfer can be made at all, and
neither is ever accepted from a request, a profile or a Bee response.
**`CHEQUEBOOK_RPC_ENDPOINTS`** is a JSON object keyed by chain id, naming the
chain the manager reads receipts from. **`CHEQUEBOOK_DOCKER_TRANSPORTS`** names,
per deploy target alias, the Docker socket the manager reaches the node's Bee
through and the qualification ids the container image must match. With either
missing, saved operations stay readable and recoverable and new transfers refuse
rather than guess. `docs/testing/t09-money-api.md` has their exact shapes and
the rules the registry applies to them.

### Engine control

The media server of one deployment: what it is configured with, and the two
things an operator does to it by hand.

| Method | Path | Body | Answer |
| ------ | ---- | ---- | ------ |
| GET | `/profiles/:name/engine` | none | `{ engine, abr, settings, defaults, fields, live, liveUnavailableReason, notInConfig }` |
| PUT | `/profiles/:name/engine-settings` | `{ HLS_FRAGMENT?, HLS_SEGMENT_MAX?, HLS_WINDOW?, SRT_LATENCY?, ABR_*? }` for SRS, the three `HLS_*` keys for OME | 202 and the profile. Recreates the engine container, and the uploader with it when a key the uploader also reads changed |
| POST | `/profiles/:name/containers/:service/restart` | none | 202. `srs`, `ome`, `stream-uploader` and `bee-uploader` only |
| GET | `/profiles/:name/containers/:service/logs?tail=200` | none | `text/plain`, at most 2000 lines |
| GET | `/profiles/:name/engine/config` | none | `text/plain`, `no-store`. The config the running container generated |
| GET | `/profiles/:name/engine-config` | none | `{ engine, supported, unsupportedReason, config, template, placeholders, error, references }`, `no-store` |
| PUT | `/profiles/:name/engine-config` | `{ config }` | 202 and the profile, or 400 with the engine's own reason. Recreates the engine and watches it |
| DELETE | `/profiles/:name/engine-config` | none | 202 and the profile. Back to the version's template |

`profiles.engine_settings` is a JSONB column holding only the keys a deployment
overrides, by their env name. An absent key means the stack's own default: the
key is not written into `.env.<name>` at all, so the base `.env` still decides
it, exactly as an unset SRT passphrase does. The fields, their bounds, their
choices and the rule that frame rate times segment length must be a whole
number of frames live in `common/src/engineSettings.ts`, which the manager, the
UI and the offline mock all read. One JSONB column rather than one per setting
because the set differs per engine and per stack version, and
`migrations/009_engine_settings.sql` says so at length.

One key is the exception since 2026-09-23. `SRT_LATENCY`, how long SRS waits
for a lost SRT packet to be resent before giving up on it, whole milliseconds
from 20 to 10000, defaults to the manager's own 2000, which the owner decided
that day. `v3.1` falls back to 200, as does every version cut before that day
which reads the key at all, and the bundled stack, `main` at `8c5c583a`, falls
back to 2000 itself. On every version an absent `SRT_LATENCY` is written into
`.env.<name>` as 2000 unless the base `.env` sets it, and the drawer calls it
"Manager default". SRS waits that long on ingest only on a stack version whose
template fills `recvlatency` as well as `latency`, as the bundled stack's does.
`v3.1` fills `latency` alone, so on it the drawer shows SRS's own 120 as
"Engine default" instead, measured on 2026-09-23 and recorded in
[engine-control.md](../docs/features/engine-control.md). It is not a key of
this manager's own environment, so the table under Environment below does not
list it.

Saving settings redeploys the engine service alone, so the profile goes
`DEPLOYING` and back while the uploader and the Bee node stay up. A restart is
below that state machine: it changes no status and publishes an
`engine.restarted` activity event instead.

Live status (what is publishing right now) is not read yet. The bundled
stack, `main` at `8c5c583a` as of 2026-09-23, publishes SRS's HTTP API port per
deployment as `SRS_HTTP_API_PORT`, and the manager does not read it yet. On the older
`main-v2` the compose file publishes no such port at all, and OvenMediaEngine's
API needs a `<Managers>` block the template does not carry on either.
`GET /profiles/:name/engine` answers `live: null` with the reason for that
deployment's version in `liveUnavailableReason`.

#### A config file of the deployment's own

Everything an engine can do beyond the settings drawer is a matter of editing
its config file, and both engines are configured by file alone: SRS by
`srs.conf`, OvenMediaEngine by `Server.xml`. Neither has a configuration web
page. The Engine card's **Config file** button opens the whole file, and the
manager stores it in `profiles.engine_config` (migration 012), whole, with the
stack's `*_PLACEHOLDER` tokens kept in it. The stack fills those at container
start, so the passphrase, the ports, the webhook token and the values from the
settings drawer never sit in the stored text, and a token the file drops is a
setting the drawer marks as not read (`notInConfig`).

It works on a stack version whose contract has the hook, `engineConfig` in
`GET /versions`, which the reader sets when the checkout ships
`deploy/docker-compose.srs-conf.yml` or the OME counterpart. The bundled
stack, `main` at `8c5c583a`, ships both. A
version without the hook, such as the stack's `main-v2`, renders its template
and the editor says so. At deploy the orchestrator writes the file to
`<data root>/<name>/engine/srs.conf` (or `Server.xml`) and names it as
`SRS_CONF_FILE` or `OME_CONF_FILE` in `.env.<name>`, which the stack's
`build_compose_files` turns into a read-only mount. The data root survives a
manager deploy, which rsyncs only the checkout, and goes with the deployment
when it is removed.

Nothing is applied unchecked. A PUT first refuses a placeholder the version's
entrypoint does not fill, then asks the engine: for SRS, `srs -t` in a
throwaway container of the version's own image (`engineImages` in the
contract), on a copy with every placeholder filled by a dummy value, and the
line SRS names comes back as the 400. OvenMediaEngine has no test mode, so it
gets a well-formedness check and the watch. Then the deployment is claimed the
way a settings save claims it, the file stored, the engine recreated, and the
container inspected every two seconds for twenty. An engine that is not a
running container with no restarts by then gets the previous file back, is
recreated again, and `engine_config_error` on the profile says why, with the
engine's last log lines. The watch lives in the manager process: a manager
restart during those twenty seconds leaves the new file applied and nothing
reverted.

Where every directive is documented: SRS's annotated
[full.conf](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf)
and OvenMediaEngine's
[configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration).
The stack's own notes are in `engines/README.md` under "Your own config file".

### Stack versions

A version is a branch or tag of `swarm-hls-stream` pinned to a commit, checked
out and built once, with its deploy contract read out of the checkout rather
than assumed: the port table from `deploy/scripts/_lib.sh`, the port slot
ceiling from `deploy.sh`, the secrets the containers refuse to start without
from the `.env.sample` files, and the engine defaults from the entrypoints. A
moving branch changes nothing until `update` is called.

The **bundled** version is the stack commit the manager pins, and the host
fetches and builds it there like any other version. The pin is
`manager/.stack-commit`, which `deploy/deploy.sh` writes from the repository
with `git rev-parse HEAD:manager/swarm-hls-stream`, so it is the submodule pin
whether or not the submodule is checked out. The API reads it at boot and builds
that commit when it has no complete build of it, and **Update** on the bundled
card builds it again. It is the default until another is chosen, and it cannot
be removed. A manager that pins no commit, which is a developer machine, keeps
the row on the tree in the checkout and refuses the rebuild, saying so. The
stack's `main-v2` is obsolete and is kept only as a second version to test
version selection with.

Every deployment runs one version, chosen in the new deployment wizard when
more than one has finished building and preselected to the default. `POST
/profiles` and `POST /groups` take `stack_version_id`, absent means the default,
and a version still building or failed is refused. A group's members all run
the version the group was made on. A deployment stays on its version: moving
one is not offered. Only a version marked **tested** can be made the default,
which a person sets by hand after one real deployment has run on it, because
reading a checkout's scripts proves its shape and not its behaviour.

What the version's contract decides for a deployment on it: the port table the
container snapshot and the OME ports are computed from, the port slot ceiling
(99 on the bundled `main` at `8c5c583a`, 999 on the older `main-v2`, and the
manager caps both at 100 whatever the contract declares), the engine defaults the settings
drawer names, whether the engine can run on a config file of its own, and the
secrets its containers refuse to start without. Those secrets,
`API_AUTH_TOKEN`, `SRS_WEBHOOK_TOKEN` and `OME_ADMISSION_SECRET` on the bundled
`main` at `8c5c583a`, are generated the first
time the deployment is deployed, 64 hex characters each, kept in
`profiles.stack_secrets`, written into `.env.<name>` at every deploy and never
answered by the API.

| Method | Path                    | Body            | Answer                                                          |
| ------ | ----------------------- | --------------- | --------------------------------------------------------------- |
| GET    | `/versions`             |                 | `[{ id, name, gitRef, commitSha, status, isDefault, tested, builtAt, lastError, contract, deployments }]` |
| POST   | `/versions`             | `{ name, ref }` | SSE build log, then `version.changed` on `/events`.              |
| POST   | `/versions/:id/update`  |                 | SSE build log. On `bundled` it builds the commit the manager pins, and refuses when it pins none. |
| POST   | `/versions/:id/default` |                 | 204. Refused for a version still building or not marked tested.  |
| PATCH  | `/versions/:id`         | `{ tested, commitSha?, buildId? }` | 200 and the row. Marking tested requires the commit the page showed, and the build id too unless the row is legacy. |
| DELETE | `/versions/:id`         |                 | 204, or 409: the deployment names when it is in use, or the bundled version, the default, one that is building, one with an unresolved build reference or execution, or one whose identity moved while removal waited. |
| GET    | `/versions/:id/settings` |                | `{ generation, buildGeneration, buildId, files, leftAlone }`, or 409 `settings_not_ready`. `Cache-Control: no-store`. |
| PUT    | `/versions/:id/settings` | `{ expectedGeneration, files }` | `{ generation }`, or 409 `settings_changed`, 409 `settings_locked`, 400 on a value, 413 `payload_too_large`. |
| POST   | `/versions/:id/settings/apply` |          | `{ buildId, reused }`, or 409 `stack_build_busy`, 409 `settings_not_ready`, 409 `settings_locked`. |

#### The settings page

Every version keeps three kinds of file the operator owns, beside its checkout:
the base `.env`, `deploy/config.json` and one `.env` per engine. They are seeded
from the version's own samples by its first build and no build ever writes over
them. **Settings** on a version card opens `#/versions/<id>/settings`, one
section per file, in the order base env, deploy config, engines.

Each key of an env file shows what the version's `.env.sample` says about it,
which is the comment block directly above the key in that sample. That block
ends at a commented out assignment of another key, because those lines document
that key, and a section rule such as `# --- Logging ---` is dropped. A value
that still equals the sample's is marked `default`. A secret-like key is masked
until **Reveal** is pressed: the values do come back in the clear, because the
routes are behind the session gate and a value the operator cannot see is one
they cannot check, and nothing logs one, nothing caches the answer and no
browser is asked to remember a masked field. A key the manager fills per
deployment says so. A key the version's sample does not declare carries
**Remove**, which takes the line out of the file on the next save.

A value has to be one the stack's own env loader and the manager read the same
way, which is `settingValueProblem` in `common`. Padding at either end, an
unquoted space before a `#`, a quote that does not close at the end and a
control character are all refused, by the field before the save goes out and by
the route with a 400 naming the key. `SRS_CONF_FILE` and `OME_CONF_FILE` take
only an absolute path or nothing, because the version's compose override mounts
whatever they hold into the engine container.

**Save** writes the files as one revision, and refuses with 409
`settings_changed` when anything moved since the page loaded, so a page and an
`ssh` editing session cannot write over each other. An env file is rewritten
from its own current bytes: the named lines get the new value, and every
comment, blank line and spacing survives byte for byte. One save carries at most
sixteen files and 512 keys per file, names each file once, and a body over the
request limit comes back as 413 rather than as a fault. While an editing session
holds the lock every one of these routes answers 409 `settings_locked` with what
holds it and how to get it back, and the page offers **Try again**.

The header says which revision the files are at and, when the current build
already carries it, `applied`. When it does not, the page says which revision
the build carries and that new deployments do not have the change until Apply
makes a build. A path of the set that holds a link or a directory rather than a
file is named as left alone rather than dropped, because nothing here reads or
writes one.

**Save and apply** saves and then publishes another build of the same commit
carrying the new revision, rather than fetching and building the stack again for
one changed line. The new build is the current build's tree with the settings
files replaced, its unchanged files hard linked to the build it was made from
where the filesystem allows and copied otherwise, which the manifest records as
`treeSharing`. It takes the build mutex for its whole run and refuses with 409
`stack_build_busy` while a build runs. New deployments run the new build.
Deployments already running keep the settings they started with until they are
deployed again. A build of the same commit already carrying this revision is
answered as it stands, with `reused` true and nothing published, so applying
twice makes one build rather than two and the version's approval survives. Every
build's copy of a settings file is written owner only, as the deployment's own
`.env.<profile>` is, and no `.env.<profile>` is ever shared between two builds.

A version still deploying from a flat checkout has no build to make another one
from, so its **Settings** button says to Update it first.

A generated secret the version's own base or engine env already sets is neither
generated nor written per deployment, so the version's line is what the
containers read. The base env decides every key it assigns, blank included,
because the root file wins over the engine's in the stack's deploy script, and
the engine env decides only a key the base env does not assign at all. An empty
one is generated per deployment as before, and a value already in
`profiles.stack_secrets` still wins over both, because rotating the token a
running container was started with is a decision rather than a side effect.

Adding and updating run `manager/scripts/stack-version-build.sh <repo-root>
<staging-dir> <ref> <repo-url> <attempt-id>`, which clones or fetches, exports
the fetched commit into the staging tree under the version's builds directory,
and builds the packages there in a throwaway `node:22-alpine` container shown
that tree and nothing else. The manager then publishes the built tree as a
numbered build of its own, seeds the version's host-owned root from the build's
samples, `.env`, each engine's `.env` and `deploy/config.json`, each only where
the root has no file of its own, and removes the staging tree. One build
runs at a time: the stack still tags its images by service name alone, so two
at once would overwrite each other's tags.

Adding a version runs that branch's deploy scripts with the manager's Docker
access, so only branches you trust belong here. The build container is shown
the staging tree and never the root, because the root holds every deployment's
`.env.<profile>` with its stream key, SRT passphrase and postage batch in it.

### Misc

| Method | Path        | Notes                             |
| ------ | ----------- | --------------------------------- |
| GET    | `/health`   | DB ping. Returns `{status:"ok"}`. |
| GET    | `/services` | List of valid service names.      |

### Resource metrics

Real-time CPU / memory / network / disk usage at four layers: the **host** (the
whole box, including non-Docker usage), the **infra** (the sum of all our
containers), **outside** (the host minus our infra, so what everything else on
the box is using), and **per container** (grouped by compose project, i.e.
profile). `common/src/metrics.ts` is the shape, and the manager, the frontend
and the offline mock all read it from there.

| Method | Path              | Notes                                                              |
| ------ | ----------------- | ----------------------------------------------------------------- |
| GET    | `/metrics`        | Latest snapshot as JSON. `503` until the first sample is ready.    |
| GET    | `/metrics/stream` | Server-Sent Events, one `snapshot` event every ~2s while watching. |

Sampling is gated: the collector only polls Docker while at least one client is
connected to `/metrics/stream` (or immediately after a `/metrics` request).

Snapshot shape:

```jsonc
{
  "timestamp": "2026-06-07T14:30:00.000Z",
  "host":  { "cpuPercent": 37.2, "ncpu": 8,
             "memUsedBytes": 9663676416, "memTotalBytes": 33554432000,
             "diskUsedBytes": 81604378624, "diskTotalBytes": 512110190592,
             "netRxBytes": 8388608, "netTxBytes": 16777216,
             "netRxRate": 20480, "netTxRate": 40960,
             "diskReadBytes": 0, "diskWriteBytes": 8192,
             "diskReadRate": 0, "diskWriteRate": 4096 },
  "infra": { "cpuPercent": 142.5, "memUsageBytes": 5368709120,
             "netRxBytes": 4194304, "netTxBytes": 8388608,
             "netRxRate": 10485, "netTxRate": 20971,
             "blkReadBytes": 0, "blkWriteBytes": 4096,
             "blkReadRate": 0, "blkWriteRate": 2048, "containerCount": 6 },
  "outside": { "cpuPercent": 155.1, "memUsageBytes": 4294967296 },
  "containers": [
    { "id": "abc123…", "name": "streamer1-srs-1",
      "project": "streamer1", "service": "srs", "state": "running",
      "restartCount": 0,
      "cpuPercent": 72.4, "memUsageBytes": 268435456,
      "memLimitBytes": 2147483648, "memPercent": 12.5,
      "netRxBytes": 1048576, "netTxBytes": 2097152,
      "netRxRate": 5120, "netTxRate": 10240,
      "blkReadBytes": 0, "blkWriteBytes": 4096,
      "blkReadRate": 0, "blkWriteRate": 2048, "pids": 14 }
  ]
}
```

Notes:

- `cpuPercent` is share-of-one-core × 100, so an 8-core box tops out at 800 and
  the host field is normalised to 0–100. `*Rate` fields are bytes/second derived
  from deltas, so they read `0` on the first sample after (re)connecting.
- `restartCount` is how many times the daemon has restarted that container, read
  on a slower cadence than the rest of the row. It is the field that says a
  container is crash looping, because a container that dies and comes back reads
  as `running` in between. A Bee node that had never been funded sat in that loop
  for six days, 2,760 restarts, while every page called it running.
- `outside` subtracts exactly for CPU and memory only. Network and disk I/O are
  measured at different points for the host and for containers, so they are shown
  side by side rather than subtracted.
- **Host CPU/RAM/network/disk need read-only host mounts** (`/proc → /host/proc`,
  `/ → /host/rootfs`, already wired in `docker-compose.yml`). Without them,
  host fields fall back to capacity only or `null`. Infra and per-container
  numbers still work from the docker socket alone. Host network traffic is read
  from `/host/proc/1/net/dev`, the host init process's network view. Adding the
  mounts requires a redeploy.

Test without the UI (over the SSH tunnel, `ssh -L 8080:localhost:8080 viewer`
exposes the web port, which is the way to the API under compose too, because the
api container publishes no port of its own. The port below is the `pnpm dev`
one, so read `8080` for `9876` when the manager runs under compose):

```bash
# one-shot (cookies.txt comes from the sign-in under Example session)
curl -sS -b cookies.txt localhost:9876/metrics | jq

# live stream (Ctrl-C to stop)
curl -N -b cookies.txt localhost:9876/metrics/stream
```

## Example session

Sign in first. The cookie file carries the session through the rest, and every
request that is not a GET also needs the `X-Requested-With` header, without
which the manager answers 403 whatever the cookie says. The port below is the
`pnpm dev` one. Under compose the same paths answer on the web port,
`localhost:8080`.

```bash
# Sign in once, keeping the session cookie in a file
curl -sS -c cookies.txt -X POST localhost:9876/auth/login \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"username":"levi","password":"<the password>"}'

# Allocate streamer1 (port_slot=1)
curl -sS -b cookies.txt -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"name":"streamer1","kind":"streamer"}'

# Allocate viewer1 (port_slot=2)
curl -sS -b cookies.txt -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' \
  -d '{"name":"viewer1","kind":"viewer"}'


# Deploy and watch the logs stream
curl -N -b cookies.txt -X POST localhost:9876/profiles/streamer1/deploy \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' -d '{}'
curl -N -b cookies.txt -X POST localhost:9876/profiles/viewer1/deploy \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' -d '{}'

# Tear down + release. One call: it stops the containers, removes the
# deployment's data directory and its execution copies, and frees the slot.
curl -b cookies.txt -X DELETE localhost:9876/profiles/streamer1 \
  -H 'X-Requested-With: streaming-infra-manager'
```

## Environment

Everything comes from `manager/.env`. `manager/.env.sample` documents the keys
an operator sets by hand. Five more are used that it does not carry:
`SHLS_ROOT` and `BEE_DATA_ROOT`, which `docker-compose.yml` sets for the `api`
container, `WEB_PORT`, which the compose file interpolates for the `web` port
binding, and the two below that decide whether a chequebook transfer can be
made at all.

**`CHEQUEBOOK_RPC_ENDPOINTS`** and **`CHEQUEBOOK_DOCKER_TRANSPORTS`** have no
default and no fallback. With either missing, saved operations stay readable and
recoverable and every new transfer refuses rather than guessing. Their exact
shapes are in `docs/testing/t09-money-api.md`. Neither belongs in a file that is
committed: route the value into the process rather than writing it down.

The keys that decide where the streaming stack lives, the ssh identity the
manager deploys to other hosts with, the chain endpoint it offers the Bee nodes
it creates, the address the API binds and where it reads the host's own numbers:

| Variable              | Default                                            | What it points at                                                                  |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SHLS_ROOT`           | the submodule next to the manager source           | The legacy bundled checkout, read once to carry its settings over and still mounted by engines that were deployed from it. Set by `docker-compose.yml` to the host bind mount. |
| `STACK_VERSIONS_ROOT` | `/home/solarpunk/streaming-infra-manager-versions` | Where every version lives, the bundled one included: a clone, its builds and its settings files.                                |
| `MANAGER_SSH_DIR`     | `/home/solarpunk/manager-ssh`                      | The ssh identity the manager deploys to other hosts with: the deploy key, `known_hosts`, and an `ssh_config` with a `Host` block per target alias. Mounted at `/root/.ssh` in the api container, whose image links `/etc/ssh/ssh_config` to the `ssh_config` in it. `deploy.sh` creates the directory, empty, so it is only filled when a deployment's host is not `localhost`. See [deploy/README.md](../deploy/README.md). |
| `BEE_RPC_ENDPOINT`    | none                                               | The chain endpoint every Bee node created here is offered first, which is what `rpc_endpoint_source: manager` writes into a deployment's env file. Optional, and a malformed value stops the manager at startup rather than reverting to the stack's public RPC. Such a URL can carry an API key: `GET /config` answers only its host, the container logs this manager serves and the deploy output it stores have it taken out of them, and the manager's own boot line prints its host. The Bee node prints the whole address into its own container log on the host it runs on, which no manager code can prevent, so the safe shape is an address carrying no key, such as a proxy on the host that holds it. Removing the variable from a manager that has deployments on it refuses their next edit and their next deploy with it named, which is the alternative to moving them onto the public endpoint in silence. |
| `MANAGER_HOST`        | `0.0.0.0`                                          | The address the API binds. Every interface by default, which is what the `web` container needs to reach the `api` container. Narrow it to `127.0.0.1` when the manager runs on the host and the port should answer nothing but the loopback. |
| `HOST_PROC`           | `/host/proc`, then `/proc`                         | Where the resource monitor reads the host's CPU, memory, disk I/O and init process network view. `docker-compose.yml` bind-mounts the host's `/proc` there read-only, and the fallback is the current machine's `/proc`, so a manager run outside Docker reports its own box. |
| `HOST_ROOTFS`         | `/host/rootfs`, then `/`                           | Where the resource monitor reads the host's disk, mounted read-only the same way, with the same fallback. |

The first two are bind-mounted into the api container at the same absolute path
they have on the host, because the docker daemon runs on the host and reads
every path in a compose file as a host path.

## Limitations (intentional, v1)

- **Max 100 managed profiles per host.** `--portSlot` is an integer from 1 to
  100. A stack version may declare a lower ceiling of its own, and the manager
  takes the lower of the two. A stopped deployment still holds its slot.
- **No HTTPS of its own.** The sign-in gate is only as good as the transport in
  front of it. The `edge` service in `docker-compose.yml` is that transport: a
  Caddy container in the `public` compose profile that terminates TLS and gets
  its own certificate for `MANAGER_DOMAIN`. It starts only when that name is
  set, and `deploy/README.md` has the steps for turning it on.
- **Streamed SSE.** A deploy answers over an HTTP connection held open for the
  whole run. Closing it does not stop the run: only the health check is killed
  when its client goes away. A deploy, a deploy-uploader or a stop finishes on
  its own, the row's new state arrives as `profile.changed` on `/events`, and a
  manager restarted mid-run reconciles the row at boot.
- **A target is verified before it is used.** `localhost` is the ordinary case.
  Another alias is refused until the target table has read a Docker daemon
  identity on it over ssh, and an alias that cannot be verified is refused
  rather than assumed. The ssh identity that makes this possible is described
  in "Deploying Bee nodes to other hosts" in `deploy/README.md`.
