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
```

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

### Misc

| Method | Path        | Notes                             |
| ------ | ----------- | --------------------------------- |
| GET    | `/health`   | DB ping. Returns `{status:"ok"}`. |
| GET    | `/services` | List of valid service names.      |

## Example session

```bash
# Allocate streamer1 (port_slot=1)
curl -sS -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"streamer1","kind":"streamer"}'

# Allocate viewer1 (port_slot=2)
curl -sS -X POST localhost:9876/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"viewer1","kind":"viewer"}'


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

## Limitations (intentional, v1)

- **Max 999 managed profiles per host** — `--portSlot` is an integer 1–999.
- **No auth.** Internal/test tool; deploy behind a firewall.
- **Synchronous SSE.** A deploy holds an HTTP connection open for its duration;
  client disconnect kills the child.
- **Local target only.** This iteration assumes `config.json` deploys to
  `localhost`, which matches the "one manager per host" plan.
