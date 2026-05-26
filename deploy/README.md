# Server deployment

Single-server deployment: postgres + manager API + nginx-served frontend, all
in one `docker compose` project. Team access via SSH tunnel — no public ports.

## One-time server bootstrap

Server runs as user `solarpunk`, code lives at `/home/solarpunk/streaming-infra-manager`.

```sh
# As solarpunk@server
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin rsync
sudo usermod -aG docker solarpunk
# log out + back in so the group takes effect

mkdir -p ~/streaming-infra-manager/manager
```

Make sure `manager/.env` exists in your local checkout — it gets rsynced to
the server on every deploy (your laptop is the source of truth). Example:

```env
POSTGRES_PASSWORD=<pick-something>
LOG_LEVEL=info
WEB_PORT=8080
# DATABASE_URL is overridden inside the api container by docker-compose.yml.
# This value is only used if you also run `pnpm dev` on the server (you won't).
DATABASE_URL=postgres://manager:manager@localhost:5432/manager
MANAGER_PORT=9876
```

## Local `~/.ssh/config` snippet

```
Host manager-host
  HostName <server-ip-or-hostname>
  User solarpunk
  LocalForward 8080 localhost:8080
```

## Deploying

From your local checkout:

```sh
./deploy/deploy.sh manager-host
```

This rsyncs the repo (minus `node_modules`, `.git`, server `.env`), then
`docker compose up -d --build` on the server.

## Accessing

```sh
ssh manager-host       # the LocalForward in ssh_config opens the tunnel
# then in your browser:
open http://localhost:8080
```

If you skip the ssh_config entry: `ssh -L 8080:localhost:8080 solarpunk@<server>`.

## Operations

All run on the server (`ssh manager-host`, then `cd ~/streaming-infra-manager/manager`):

```sh
docker compose ps                 # status
docker compose logs -f api        # tail manager logs
docker compose logs -f web        # tail nginx logs
docker compose restart api        # restart just the manager
docker compose down               # stop everything (postgres volume kept)
docker compose down -v            # nuke postgres data too — be sure
```

## Architecture notes

- **`web`** (nginx:alpine) is the only service that publishes a port off-host
  (`8080:80`). It serves the built React SPA and reverse-proxies `/profiles`,
  `/groups`, `/health`, `/services`, `/events` to `api:9876`.
- **`api`** has no published port — only reachable via the `web` proxy on
  the internal compose network.
- **`postgres`** is bound to `127.0.0.1:5432` so a host-side `pnpm dev`
  (during local iteration) can connect, but it's never reachable off-host.
- The whole repo is bind-mounted into the `api` container at the same
  absolute path it has on the host (`/home/solarpunk/streaming-infra-manager`).
  This is so compose files under `manager/swarm-hls-stream/` resolve volume
  paths consistently when their `docker compose up` is forwarded to the host
  daemon via the mounted socket.
