# Manager API

Thin TypeScript backend that runs the `swarm-hls-stream` deploy scripts on
demand and tracks each profile's `port_slot` in PostgreSQL so two profiles
on the same host can never collide on a port.

## Stack

- **Express 5** + ESM + **TypeScript**
- **PostgreSQL 16** — single source of truth for `port_slot` allocations (1–999)
- **Yup** — request body / params validation at the API edge
- **dotenv** — config from `.env`
- **Docker-out-of-Docker** — the API container spawns `bash deploy.sh ...`,
  which calls `docker compose` against the host daemon via a mounted
  `/var/run/docker.sock`

## Quick start (one host, "localhost" deploys)

```bash
cp manager/.env.sample manager/.env
cd manager
docker compose up --build -d
curl localhost:9876/health                      # {"status":"ok"}
docker compose exec -it api node dist/cli.js user:add <username>
```

Until that last command has been run once, every route but `/health` and
`POST /auth/login` answers 401, and the sign-in page says so.

## Authentication

Every route needs a session except two: `GET /health`, which Docker's
healthcheck reads, and `POST /auth/login`. That includes both Server-Sent
Events streams, `/config`, `/metrics` and `/profiles`.

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

The token is 32 random bytes; the database stores only its SHA-256, so a dump of
the sessions table signs nobody in. A session ends after twelve hours of
inactivity, and fourteen days after it started whatever happens in between.

Signing out, revoking a user's sessions, removing a user or changing a password
also closes that session's open event streams at once, so a browser stops
receiving profile events the moment it stops being signed in. A session that
runs out rather than being revoked has its streams closed within a minute, and a
stream is not activity, so a page left open with nothing but its streams still
idles out after twelve hours.

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
| GET | `/auth/session` | | `{ username, expiresAt }`, or 401 with `not_signed_in` or `no_users` |
| POST | `/auth/password` | `{ current, next }` | 204, every other session of yours revoked |
| GET | `/auth/users` | | `[{ id, username, createdAt, lastLoginAt, sessions }]` |
| POST | `/auth/users` | `{ username, password }` | 201, 409 taken |
| DELETE | `/auth/users/:id` | | 204, 409 for yourself or the last user |
| POST | `/auth/users/:id/revoke-sessions` | | 204 |

## API

All command endpoints stream output as Server-Sent Events
(`start` / `stdout` / `stderr` / `error` / `done`). Use `curl -N` to follow.

### Profiles

| Method | Path              | Body                                              | Notes                                                         |
| ------ | ----------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/profiles`       | `{ name, kind?: "streamer"\|"viewer"\|"custom" }` | Allocates lowest free `port_slot` (1–999), seeds from `.env`. |
| GET    | `/profiles`       | —                                                 | List ordered by `port_slot`.                                  |
| GET    | `/profiles/:name` | —                                                 | Single profile.                                               |
| DELETE | `/profiles/:name` | —                                                 | Releases the slot.                                            |

### Actions (per profile, SSE)

| Method | Path                     | Body                      | Maps to                                                |
| ------ | ------------------------ | ------------------------- | ------------------------------------------------------ |
| POST   | `/profiles/:name/deploy` | `{ services?: string[] }` | `deploy.sh --profile=<name> --portSlot=<n> [services]` |
| POST   | `/profiles/:name/stop`   | `{ services?: string[] }` | `stop.sh   --profile=<name> --portSlot=<n> [services]` |
| GET    | `/profiles/:name/health` | —                         | `health.sh --profile=<name> --portSlot=<n>`            |

When `services` is omitted:

- `streamer` → `srs stream-uploader bee-uploader`
- `viewer` → `client bee-gateway`
- `custom` → empty (the script then uses everything enabled in `config.json`)

Media engines: `srs` (default) and `ome` are mutually exclusive — a profile's
`components` may contain at most one of them. Including `ome` makes the manager
write `ENGINE=ome` (plus slot-shifted `OME_SRT_PORT`/`OME_HLS_PORT`) into the
profile's `.env.<name>` so the stream-uploader runs the OvenMediaEngine plugin.

SRT passphrase: a profile may carry its own `srt_passphrase`, written to
`.env.<name>` as `SRT_PASSPHRASE` so SRS encrypts that deployment's SRT listener
with it. Left unset, the base `.env`'s host-wide value applies — the behaviour
before the field existed. SRS only; OME's SRT listener takes no passphrase.
Accepted values are 10–79 characters of `A-Z a-z 0-9 . _ ~ -`; the bounds are
libsrt's and the character set keeps the value intact through the `sed` in
`engines/srs/entrypoint.sh`, the env file, the srs.conf directive and the
`srt://…&passphrase=` publish URL (see `common/src/srtPassphrase.ts`).

### Misc

| Method | Path        | Notes                             |
| ------ | ----------- | --------------------------------- |
| GET    | `/health`   | DB ping. Returns `{status:"ok"}`. |
| GET    | `/services` | List of valid service names.      |

### Resource metrics

Real-time CPU / memory / network / disk usage at three nested layers: the
**host** (the whole box, including non-Docker usage), the **infra** (the sum of
all our containers), and **per container** (grouped by compose project, i.e.
profile).

| Method | Path              | Notes                                                              |
| ------ | ----------------- | ----------------------------------------------------------------- |
| GET    | `/metrics`        | Latest snapshot as JSON. `503` until the first sample is ready.    |
| GET    | `/metrics/stream` | Server-Sent Events; one `snapshot` event every ~2s while watching. |

Sampling is gated: the collector only polls Docker while at least one client is
connected to `/metrics/stream` (or immediately after a `/metrics` request).

Snapshot shape:

```jsonc
{
  "timestamp": "2026-06-07T14:30:00.000Z",
  "host":  { "cpuPercent": 37.2, "ncpu": 8,
             "memUsedBytes": 9663676416, "memTotalBytes": 33554432000,
             "diskUsedBytes": 81604378624, "diskTotalBytes": 512110190592 },
  "infra": { "cpuPercent": 142.5, "memUsageBytes": 5368709120,
             "netRxRate": 10485, "netTxRate": 20971, "containerCount": 6 },
  "containers": [
    { "id": "abc123…", "name": "streamer1-srs-1",
      "project": "streamer1", "service": "srs", "state": "running",
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
- **Host CPU/RAM/disk need read-only host mounts** (`/proc → /host/proc`,
  `/ → /host/rootfs`, already wired in `docker-compose.yml`). Without them,
  host fields fall back to capacity-only / `null`; infra and per-container
  numbers still work from the docker socket alone. Adding the mounts requires a
  redeploy.

Test without the UI (over the SSH tunnel, `ssh -L 8080:localhost:8080 viewer`
exposes the web port; for the API use the manager port directly on the host):

```bash
# one-shot (cookies.txt comes from the sign-in under Example session)
curl -sS -b cookies.txt localhost:9876/metrics | jq

# live stream (Ctrl-C to stop)
curl -N -b cookies.txt localhost:9876/metrics/stream
```

## Example session

Sign in first. The cookie file carries the session through the rest, and every
request that is not a GET also needs the `X-Requested-With` header, without
which the manager answers 403 whatever the cookie says.

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

# Tear down + release
curl -N -b cookies.txt -X POST localhost:9876/profiles/streamer1/clean \
  -H 'content-type: application/json' \
  -H 'X-Requested-With: streaming-infra-manager' -d '{"volumes":true}'
curl -b cookies.txt -X DELETE localhost:9876/profiles/streamer1 \
  -H 'X-Requested-With: streaming-infra-manager'
```

## Limitations (intentional, v1)

- **Max 999 managed profiles per host** — `--portSlot` is an integer 1–999.
- **No HTTPS of its own.** The sign-in gate is only as good as the transport in
  front of it. The `edge` service in `docker-compose.yml` is that transport: a
  Caddy container in the `public` compose profile that terminates TLS and gets
  its own certificate for `MANAGER_DOMAIN`. It starts only when that name is
  set, and `deploy/README.md` has the steps for turning it on.
- **Synchronous SSE.** A deploy holds an HTTP connection open for its duration;
  client disconnect kills the child.
- **Local target only.** This iteration assumes `config.json` deploys to
  `localhost`, which matches the "one manager per host" plan.
