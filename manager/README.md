# Manager API

Thin TypeScript backend that runs the `swarm-hls-stream` deploy scripts on
demand and tracks each profile's `port_prefix` in PostgreSQL so two profiles
on the same host can never collide on a port.

## Stack

Aligned with `swarm-hls-stream/packages/stream-uploader`:

- **Express 5** + ESM + **TypeScript**
- **PostgreSQL 16** — single source of truth for `port_prefix` allocations (1–9)
- **Yup** — request body / params validation at the API edge
- **dotenv** — config from `.env`
- **Docker-out-of-Docker** — the API container spawns `bash deploy.sh ...`,
  which calls `docker compose` against the host daemon via a mounted
  `/var/run/docker.sock`

## Layout

```
manager/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # bootstrap: build deps tree, start server, graceful shutdown
    ├── api/
    │   ├── server.ts         # express app + middleware wiring (deps injected)
    │   ├── sse.ts            # bridge ScriptRunner output → Server-Sent Events
    │   ├── middleware/       # asyncHandler, errorHandler, notFound, requestLogger, validate
    │   └── routes/           # health, profiles, actions  (each is `createXxxRouter(deps)`)
    ├── libs/                 # service layer
    │   ├── Logger.ts             singleton, same as stream-uploader
    │   ├── Database.ts           pg pool + migration runner
    │   ├── ProfileRepository.ts  raw SQL — pure data access
    │   ├── ProfileService.ts     port allocation, env file seeding, domain errors
    │   ├── ScriptRunner.ts       spawn bash → EventEmitter
    │   └── DeployService.ts      maps (profile, action, input) → script invocation
    ├── schemas/              # yup validators (profile, action)
    ├── utils/                # config, repo path helpers
    ├── types.ts              # shared types (ProfileKind, ServiceName, defaults)
    └── migrations/001_init.sql
```

### Dependency injection

No DI container — just constructor / factory injection, the same pattern used
by `stream-uploader`. `index.ts` wires everything top-down:

```text
Database               <-- DATABASE_URL
   └─ ProfileRepository (pool)
        └─ ProfileService (repo)         ──────┐
ScriptRunner                                   │
   └─ DeployService (profileService, runner) ──┤
                                               ▼
                              startApiServer({ database, profileService, deployService })
                                               │
                              createProfilesRouter(profileService)
                              createActionsRouter(deployService)
                              createHealthRouter(database)
```

That means service classes never reach for globals: tests can construct any
service with stubs and routes can mount with whatever implementation is
relevant. The pattern is intentionally identical to
`swarm-hls-stream/packages/stream-uploader/src/api/server.ts`.

## Quick start (one host, "localhost" deploys)

```bash
cp manager/.env.sample manager/.env
# Edit manager/.env — set REPO_HOST_PATH to the absolute host path of this checkout.
cd manager
docker compose up --build -d
curl localhost:9876/healthz                      # {"status":"ok"}
```

The plan is to run a manager container on every host, with each manager
deploying only to "localhost" — see `swarm-hls-stream/deploy/config.json`
for the topology side of that.

## API

All command endpoints stream output as Server-Sent Events
(`start` / `stdout` / `stderr` / `error` / `done`). Use `curl -N` to follow.

### Profiles

| Method | Path              | Body                                              | Notes                                                                              |
| ------ | ----------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/profiles`       | `{ name, kind?: "streamer"\|"viewer"\|"custom" }` | Allocates lowest free `port_prefix` (1–9), seeds `<repo>/.env.<name>` from `.env`. |
| GET    | `/profiles`       | —                                                 | List ordered by `port_prefix`.                                                     |
| GET    | `/profiles/:name` | —                                                 | Single profile.                                                                    |
| DELETE | `/profiles/:name` | —                                                 | Releases the prefix and deletes `.env.<name>`. **Run `clean` first if needed.**    |

### Actions (per profile, SSE)

| Method | Path                     | Body                                               | Maps to                                                   |
| ------ | ------------------------ | -------------------------------------------------- | --------------------------------------------------------- |
| POST   | `/profiles/:name/deploy` | `{ services?: string[] }`                          | `deploy.sh --profile=<name> --portPrefix=<n> [services]`  |
| POST   | `/profiles/:name/stop`   | `{ services?: string[] }`                          | `stop.sh   --profile=<name> --portPrefix=<n> [services]`  |
| POST   | `/profiles/:name/clean`  | `{ volumes?: bool, all?: bool, services?: [...] }` | `clean.sh  --profile=<name> --portPrefix=<n> --yes [...]` |
| GET    | `/profiles/:name/health` | —                                                  | `health.sh --profile=<name> --portPrefix=<n>`             |

When `services` is omitted:

- `streamer` → `srs stream-uploader bee-uploader`
- `viewer` → `client bee-gateway`
- `custom` → empty (the script then uses everything enabled in `config.json`)

### Misc

| Method | Path        | Notes                             |
| ------ | ----------- | --------------------------------- |
| GET    | `/healthz`  | DB ping. Returns `{status:"ok"}`. |
| GET    | `/services` | List of valid service names.      |

## Example session

```bash
# Allocate streamer1 (port_prefix=1)
curl -sS -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"streamer1","kind":"streamer"}'

# Allocate viewer1 (port_prefix=2)
curl -sS -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"viewer1","kind":"viewer"}'

# Edit per-profile env (STAMP, STREAM_KEY, *_DATA_DIR, etc.)
$EDITOR swarm-hls-stream/.env.streamer1
$EDITOR swarm-hls-stream/.env.viewer1

# Deploy and watch the logs stream
curl -N -X POST localhost:9876/profiles/streamer1/deploy \
  -H 'content-type: application/json' -d '{}'
curl -N -X POST localhost:9876/profiles/viewer1/deploy \
  -H 'content-type: application/json' -d '{}'

# Tear down + release
curl -N -X POST localhost:9876/profiles/streamer1/clean \
  -H 'content-type: application/json' -d '{"volumes":true}'
curl    -X DELETE localhost:9876/profiles/streamer1
```

## Why `REPO_HOST_PATH` mirroring?

The API container talks to the **host's** Docker daemon. Bind mounts inside
`swarm-hls-stream/deploy/docker-compose.yml` (data dirs, SRS conf templates)
are resolved by the daemon using the path _as the host sees it_. If the API
container saw the repo at `/repo` and asked the daemon to bind-mount
`/repo/swarm-hls-stream/deploy/data/bee-uploader`, the host would have no
such path. Mirroring the host path inside the container side-steps the
entire class of bug.

## Limitations (intentional, v1)

- **Max 9 managed profiles per host** — `--portPrefix` is a single digit.
- **No auth.** Internal/test tool; deploy behind a firewall.
- **Synchronous SSE.** A deploy holds an HTTP connection open for its duration;
  client disconnect kills the child.
- **Local target only.** This iteration assumes `config.json` deploys to
  `localhost`, which matches the "one manager per host" plan.
