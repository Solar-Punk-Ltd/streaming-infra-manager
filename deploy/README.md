# Server deployment

Single-server deployment: postgres + manager API + nginx-served frontend, all
in one `docker compose` project. Team access over an SSH tunnel, with no public
port, until a domain is set and the Caddy edge gives it HTTPS. See "Opening the
manager to the internet" below.

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
# Empty until the manager goes public. See "Opening the manager to the internet".
MANAGER_DOMAIN=
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

This rsyncs the repo (minus `node_modules`, `.git`, build caches and the
stack's `deploy/data/`), then `docker compose up -d --build` on the server.
Both `.env` files travel with it, and `rsync --delete` means your checkout is
the only source of truth for them: an edit made on the server is undone by the
next deploy.

## The first user

The manager has a login, and there is no sign-up. Once, after the first deploy,
create a user on the server:

```sh
ssh manager-host
cd ~/streaming-infra-manager/manager
docker compose exec -it api node dist/cli.js user:add <username>
```

It asks for the password twice with nothing echoed and writes only the hash.
Until it has been run, the manager answers 401 to everything but its health
check, and the sign-in page says so.

To feed the password from a vault instead of typing it:

```sh
op read "op://<vault>/<item>/password" | \
  docker compose exec -T api node dist/cli.js user:add <username> --password-stdin
```

Every later user is added from the Access page in the UI. Anyone signed in can
add or remove a user, and nobody can remove themselves or the last one left.

## Accessing

```sh
ssh manager-host       # the LocalForward in ssh_config opens the tunnel
# then in your browser:
open http://localhost:8080
```

The sign-in page comes up first. A session lasts twelve hours of inactivity and
fourteen days at most.

If you skip the ssh_config entry: `ssh -L 8080:localhost:8080 solarpunk@<server>`.

## Opening the manager to the internet

The tunnel is the default and costs nothing to keep. Going public is these five
steps, in this order. The order is the point: a login on the manager protects
nothing while a Bee node's API sits open beside it, because that API needs no
password and can spend the node's postage and, with a whitelist, its money.

### 1. Prove the login works, over the tunnel

Deploy as above, create the first user with the CLI, sign in through the tunnel
and click around. Nothing below is worth doing until the gate is real.

### 2. Bind the Bee node APIs off the public interface

Each deployment publishes the API of every Bee node it runs, on the ports
ending 5 and 7 for its slot, and by default on every interface. Set them to the
Docker bridge address instead. **A firewall is no substitute for this**: Docker
publishes a container port by rewriting the packet's destination and forwarding
it, so a firewall's input rules never see it at all, and the DOCKER-USER rules
of step 3 filter it one way in rather than closing it. The binding is the
control.

The two settings live in `manager/swarm-hls-stream/.env` **in your local
checkout**, not on the server. That file has no `.env` exclude in the deploy
rsync, so it ships on every deploy and replaces whatever is on the server.
Find the bridge address with `ip -4 addr show docker0` on the server, usually
`172.17.0.1`:

```env
BEE_UPLOADER_API_BIND=172.17.0.1
BEE_GATEWAY_API_BIND=172.17.0.1
```

Not `127.0.0.1`. The manager reaches each node through `host.docker.internal`,
which is that same bridge address, and loopback would cut off stamp management.
If this host runs the stack with `COMPOSE_NETWORK=host`, the pair that applies
is `BEE_UPLOADER_API_LISTEN` and `BEE_GATEWAY_API_LISTEN` instead. The file's
own comments explain both.

Deploy, then redeploy each Bee node from the UI. A node picks up its new
binding on its next deploy and not before: the manager copies that base file
fresh into each deployment's own `.env.<name>` every time it deploys, which is
how a value set once reaches all of them.

### 3. Firewall the host, default deny inbound

The generator needs the name of the interface the internet arrives on. Read it
off the host:

```sh
ssh manager-host 'ip -4 route get 1.1.1.1'   # the name after "dev", often eth0
```

Then, with that name:

```sh
./deploy/host/firewall-rules.sh --iface eth0 --max-slot 20 > /tmp/manager-firewall.nft
less /tmp/manager-firewall.nft
scp /tmp/manager-firewall.nft manager-host:/tmp/
ssh manager-host 'sudo nft -f /tmp/manager-firewall.nft'
```

It prints and applies nothing itself. Read it before it becomes law. Give
`--max-slot` the highest deployment slot in use rather than the default 100, and
`--ssh-port` if sshd is not on 22.

It refuses a `--max-slot` above 100, which is lower than the 999 slots the
manager allocates. Above 100 the two port bands land on each other: first-band
slot 101 has its RTMP port on 11012, and 11012 is the second band's slot 1 P2P
port, which the ruleset opens. Opening both bands that far would put RTMP on the
internet. So a host really running a deployment above slot 100 has that
deployment's public ports left closed rather than opened, which is the safe
direction, and its viewers and Swarm peers cannot reach it until the ceiling
moves. Making the ceiling follow the stack's own port contract instead of a
constant in the script is a later change.

Keep that SSH session open and open a second one to prove you can still get in.
Nothing applied this way survives a reboot unless it is copied to
`/etc/nftables.conf`, which is both how to keep it and how to undo a mistake.

Docker has to be running when the file is applied. Its second section adds
rules to `DOCKER-USER`, a chain Docker creates at start, and `nft` refuses the
whole file and changes nothing when that chain is absent.

Three things close the doors between them, and each closes a different set:

- **The Bee API bind of step 2** closes the Bee node APIs at the source,
  whatever any ruleset says. Nothing in this file replaces it.
- **The DOCKER-USER section** closes everything else the stack publishes: the
  uploader API, the media server's HTTP and RTMP, the SRS API. Docker forwards
  a published port's traffic rather than delivering it locally, so it never
  reaches an input chain, and these rules meet it in the forward hook instead,
  matching on the port the client dialled rather than the container's.
- **The input chain** closes the host itself, its own listeners and the whole
  stack when that runs with `COMPOSE_NETWORK=host`.

### 4. DNS, then the domain

Point an A record at the server. Give the manager a name of its own rather than
an apex domain that also serves other things, because the edge sends an HSTS
header that covers subdomains for a year. Then in `manager/.env`:

```env
MANAGER_DOMAIN=manager.example.org
```

Deploy again. `deploy.sh` prints which of the two it is doing, and with a domain
set it adds `--profile public`, which starts the `edge` container. Watch the
first certificate arrive:

```sh
ssh manager-host
cd ~/streaming-infra-manager/manager
docker compose logs -f edge
```

Then open `https://manager.example.org` and sign in. The certificate and Caddy's
account key live in the `edge-data` volume, so recreating the container does not
ask Let's Encrypt for another one.

To go back to the tunnel alone, empty `MANAGER_DOMAIN` and deploy again. The
edge container is stopped and removed, the deploy checks that it is gone, and
the volume keeps the certificate for the next time it is switched on.

### 5. Keep the tunnel

`web` still publishes `127.0.0.1:8080`, and the tunnel still reaches it. That is
the way back in when the edge is down, the certificate is stuck or the domain is
wrong, so leave it there.

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

- **`edge`** (Caddy) is the only service that publishes a port to the world:
  80, 443 and 443/udp. It exists only in the `public` compose profile, which
  `deploy.sh` adds when `MANAGER_DOMAIN` is set, so without a domain it never
  starts. Clearing the domain and deploying again stops and removes the
  container, and the deploy fails rather than finishing quietly if it is still
  running afterwards. That takes naming the profile: Compose counts a service
  whose profile is inactive as one it knows about rather than an orphan, so
  `--remove-orphans` leaves it running. It terminates TLS, gets and renews its
  own certificate, and proxies everything to `web:80`.
- **`web`** (nginx:alpine) publishes `127.0.0.1:8080` and nothing else, so it is
  reachable through the SSH tunnel and from the edge over the compose network,
  never directly from outside. It serves the built React SPA and
  reverse-proxies `/auth`, `/profiles`, `/groups`, `/health`, `/services`,
  `/config`, `/metrics` and `/events` to `api:9876`.
- **`api`** has no published port at all. The `web` proxy on the internal
  compose network is the only thing that reaches it.
- **`postgres`** is bound to `127.0.0.1:5432` so a host-side `pnpm dev`
  (during local iteration) can connect, but it's never reachable off-host.
- The whole repo is bind-mounted into the `api` container at the same
  absolute path it has on the host (`/home/solarpunk/streaming-infra-manager`).
  This is so compose files under `manager/swarm-hls-stream/` resolve volume
  paths consistently when their `docker compose up` is forwarded to the host
  daemon via the mounted socket.
