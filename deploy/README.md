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

Make sure `manager/.env` exists in your local checkout. It gets rsynced to
the server on every deploy, so your laptop is the source of truth. Example:

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

This rsyncs the repo (minus `node_modules`, `.git` and build caches), seals the
streaming stack into one package and ships it, then builds the images on the
server and runs the upgrade command that publishes the package and brings the
project back up. Both `.env` files travel with the repo rsync, and
`rsync --delete` means your checkout is the only source of truth for them: an
edit made on the server is undone by the next deploy.

## What a deploy does to the bundled stack

The streaming stack the manager ships with is a version like any other, called
`bundled`, and a deploy publishes a new build of it. Three steps, in this order,
and then where the result lives.

**Seal.** On your machine, `bundled:seal` exports the files of the commit
`manager/swarm-hls-stream` is on, adds the two built directories (which are not
committed), adds that checkout's own `.env`, `deploy/config.json` and engine
envs, and writes a manifest naming every path with its mode and its hash. An
uncommitted change to the application is refused here, so what ships is always a
commit you can go back to. The result is one directory named after a shipment
id made fresh for this deploy.

**Ship.** The package is copied to
`~/streaming-infra-manager-versions/bundled.packages/` under a name ending
`.tmp`, and renamed only once every file arrived. A dropped connection therefore
leaves a staging directory the next deploy replaces, never a package the host
would read.

**Upgrade.** The server builds its images, then runs `manager:upgrade` in a
one-off container of the image it has just built. That command creates
`~/streaming-infra-manager-versions/.manager-upgrade` and holds it for the whole
run, so a second deploy started beside this one refuses instead of interleaving
with it. Inside the guard it decides whether Postgres may be started, reads the
current publication, stops the old API, checks the shipped package against the
identity it was given, migrates the database with no old API running, publishes
the package, starts the project and waits for the new API to answer its health
check. It prints one line of JSON with the receipt, which the deploy echoes.

**Where builds live.** Each published build is one immutable directory at
`~/streaming-infra-manager-versions/bundled.builds/<build id>`. Nothing is ever
written into a build again, and the previous one is kept. The tree the engines
mount, `manager/swarm-hls-stream` on the server, is never written over by a
deploy any more.

A running container keeps the files it was started with until its own deployment
is deployed again. Updating the manager does not restart anybody's stream and
does not move a deployment onto the new build.

## A deploy that stopped half way

If a deploy failed after the upgrade started, the guard directory is still
there:

```sh
ssh manager-host
ls ~/streaming-infra-manager-versions/.manager-upgrade
cat ~/streaming-infra-manager-versions/.manager-upgrade/owner.json
```

`owner.json` names the phase it stopped in: `checking`, `stopping`,
`installing`, `publishing`, `starting` or `verifying`. The next deploy refuses
while that directory exists and prints the path and the phase rather than
clearing it, because from `stopping` onwards the API may be down and only a
person can tell whether the host is in a state worth keeping.

What to look at before removing it:

```sh
cd ~/streaming-infra-manager-versions/.manager-upgrade   # read the phase
cd ~/streaming-infra-manager/manager
docker compose ps                 # is the api up, is postgres healthy
docker compose logs --tail 200 api
```

The database is safe to leave as it is. Publication is one transaction, so the
bundled version either moved onto the new build or it did not, and a rerun that
finds the shipment already published answers with the receipt it already has.

When the host looks sound, remove the directory by hand and deploy again:

```sh
rm -r ~/streaming-infra-manager-versions/.manager-upgrade
```

The next deploy is a new shipment with a new id. It does not resume the one that
stopped, and it does not need to.

### What a stopped deploy leaves in `bundled.packages/`

The other directory to look at is
`~/streaming-infra-manager-versions/bundled.packages/`. Every package a deploy
ships lands there, and a package carries the streaming stack's own `.env`, its
`deploy/config.json` and its engine envs, so a directory left there is a copy of
the secrets that deploy shipped.

A finished upgrade cleans this itself. Once it has published, it marks every
shipment an older publication left behind as superseded and then removes the
packages and the claimed copies of every shipment that published or was
superseded, printing one `[cli] removed ...` line for each. What it leaves is
what may still be needed: a package whose shipment is still registered or
prepared.

Two kinds of leftover it will not touch, because it cannot tell where they came
from:

- `sealed-<uuid>.tmp` is a copy that never finished arriving, from a deploy
  whose connection dropped during the rsync.
- `sealed-<uuid>` with an id the journal has no shipment for is a package from a
  deploy that stopped between shipping it and registering it.

The upgrade names the second kind on its own line, saying it kept it because no
shipment of this journal made it. Both are safe to remove by hand once no deploy
is running:

```sh
ssh manager-host
ls ~/streaming-infra-manager-versions/bundled.packages
rm -r ~/streaming-infra-manager-versions/bundled.packages/sealed-<the id you saw>
```

Never remove a package a deploy that is still running shipped, and never remove
anything under `bundled.builds/`, which is where the published builds live.

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
it, so a firewall's input rules never see it at all, and the forward rules
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

### 3. Generate and review the host firewall

The generator requires Node.js, this checkout's shared port policy, and a fresh
inventory export for the target. In the signed-in manager browser, open
`/targets/firewall?alias=localhost` and save the download as
`firewall-inventory.json`. Use the verified SSH alias instead of `localhost`
for a remote target, URL-encoding the alias when needed.

The export is read-only. It checks daemon identity, reservations, observed
bindings and retained immutable build contracts. It refuses unresolved jobs,
unknown owners, incomplete inventory and mutable or missing build history.
A published version is only a candidate. A retained service snapshot must be
covered by its own build contract.

With the external interface name supplied by the host operator:

```sh
./deploy/host/firewall-rules.sh --iface eth0 \
  --inventory firewall-inventory.json --max-slot 20 \
  > /tmp/manager-firewall.nft
less /tmp/manager-firewall.nft
```

The command prints a draft and applies nothing. Run it from this checkout.
The shell wrapper needs its sibling Node files and `common/src/portPolicy.js`.

Both new allocation and the generator use a maximum of 100 slots. Allocation
also honors a lower stack limit. Existing deployments keep their slots and
reservations. A stopped slot-101 RTMP endpoint on TCP 11012 causes generation
to refuse, because that port is also a legitimate v3 rung peer endpoint.
It is not treated as a closed port merely because `--max-slot` is at most 100.
Fix the conflicting ownership through the reviewed remediation process before
generating another candidate. Do not renumber a funded deployment to bypass
this refusal.

The candidate replaces only the `inet streaming_infra_manager` table. It
does not clear Docker's chains or another application's tables. Its input
chain defaults to deny and permits SSH, the web edge and the supported public
stack ports. `--ssh-port` cannot exempt a port within the protected
10000 to 19999 range.

Its forward chain covers IPv4 and IPv6. On the selected external interface,
it permits supported translated public ports and drops other translated
TCP/UDP ports in the protected range. It also drops new direct routing that
has no destination translation, including direct access to container API
ports. **Review this restriction before using the candidate on a host that
also serves as a router.** Forwarding arriving on other interfaces and
unrelated translated ports outside the protected range are left to the
host's other policies. Established and related connections remain eligible.

The forward rules match the original destination port after Docker's
translation. An accept in this table does not override a later table's drop.
See the [nftables chain documentation](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains)
for hook ordering and verdict behavior.

The export records a capture time and database fingerprint. It is evidence
from that capture, not proof that the host has remained unchanged or that a
hand-edited file is trustworthy. Re-export after deployment, reservation or
network changes. Read-only capture cannot freeze external host changes.

Before applying a reviewed file, the operator must validate it with the
host's nftables version and review coexistence with the complete existing
ruleset. Keep the SSH session open and verify a second connection after any
operator-approved application. Persist only the manager table through the
host's existing firewall configuration. Replacing all of `/etc/nftables.conf`
could discard unrelated policy.

The Bee API bind in step 2 still closes those APIs at their published
interface. The input hook covers host listeners. The forward hook covers
published container traffic. Host-network containers with unprovable bindings
cause the inventory export to refuse.

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
docker compose down -v            # nuke postgres data too, so be sure
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
