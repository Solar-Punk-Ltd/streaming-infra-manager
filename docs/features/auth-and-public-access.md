# Sign in, and opening the manager to the internet

Status, 2026-09-16. The login gate and the HTTPS edge are merged to `main-v2`. They were written
at `6dc33d1` on `feat/ai-remediation`, the head of pull request #40, which landed. Both have since
run on a host: the manager was deployed on 2026-09-11 and a second pass on 2026-09-13 reached it
over its own public domain with a certificate, rather than through the ssh tunnel. That pass is
recorded in [../handover/main-v2-remediation.md](../handover/main-v2-remediation.md).

**The host steps at the end of this page are superseded.** They were written before the stack
stopped travelling with a deploy and before the firewall generator took an inventory export, and
following them now would leave the Bee APIs open while appearing to close them. The current
procedure is "Opening the manager to the internet" in
[../../deploy/README.md](../../deploy/README.md), which is the one to follow. What is kept below
is the reasoning, because the order of the steps is the part worth understanding.

The decisions this page rests on were taken on 2026-09-05: D1 Caddy, D2 several users, D3 close
the host doors first.

## Where we are

As it stood on 2026-09-05, when this was written. The manager had no authentication of any kind,
and its own README listed that under limitations as "No auth" with "deploy behind a firewall" as
the advice. On the host the `web` container (nginx serving the frontend and
proxying the API) publishes only `127.0.0.1:8080`, the `api` container publishes nothing, and the
team reaches the UI through an SSH tunnel. Postgres is bound to loopback. The last three are still
true. The first is not: the login gate below was built and the README limitation is gone.

Making the manager public therefore has three parts, and the login is the smallest of them:

1. **A login gate in the manager.** Users, passwords, sessions, a sign-in page, and every API
   route behind it. This brief's first PR.
2. **HTTPS in front.** A password over plain HTTP is a password given away. Decision D1.
3. **Closing the other doors.** The stack the manager deploys publishes ports on the host with no
   authentication: every Bee node's API (10005 and 10007 plus slot times 10), which can buy stamps
   and, with a whitelist, send the node's money away, the uploader's API (10000 plus slot times
   10), which accepts segments that spend postage, and the media server's HTTP port. When this
   was written those were open to the internet already, unless the host had a firewall nobody had
   written down. A login on the manager does nothing for them. Decision D3, and the current steps
   in [../../deploy/README.md](../../deploy/README.md).

"Secure enough" here means: passwords stored with a slow salted hash, sessions that expire and can
be revoked, brute force throttled and logged, cross-site request forgery blocked, HTTPS with
strict transport, browser hardening headers, and no plaintext secret in any file. It does not
mean two-factor or single sign-on. Both can be added later without changing the model.

## What the operator sees

- Opening the manager while signed out shows one page: **Sign in**, with Username, Password, and a
  Sign in button. A wrong pair says `Wrong username or password.` and nothing more specific. After
  repeated failures it says `Too many attempts. Try again in 4 minutes.` The page is the same
  light or dark theme as the app.
- Signed in, the sidebar footer shows the username and a **Sign out** item. Sessions last twelve
  hours of inactivity and fourteen days at most, then the sign-in page comes back with
  `Your session ended. Sign in again.`
- A new sidebar page **Access** (`#/access`): the list of users with their last sign-in, an **Add
  user** form (username, a starting password the adder types twice and hands over in person, the
  new user is told to change it), a **Remove** per user (refused for yourself and for the last
  user), **Sign out everywhere** per user, and a **Change my password** form (current, new, new
  again). Decision D2 says whether this page exists or a single account is enough.
- If the API answers 401 in the middle of a session (revoked, expired), the app returns to Sign
  in with the message above and reloads what it needs after.

## Design

### Users and sessions

Migration `008_auth.sql`:

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$')
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
```

- **Password hashing**: Node's built-in `crypto.scrypt`, no new dependency. Parameters
  `N = 2^15, r = 8, p = 3`, 32 byte random salt, 64 byte key, `maxmem` raised to 64 MiB. Stored
  as `scrypt$N$r$p$<salt b64>$<key b64>` so the parameters can rise later and old hashes still
  verify. Comparison with `timingSafeEqual`. A password is 12 to 128 characters, anything
  printable, no composition rules, must not contain the username.
- **Session token**: 32 random bytes, base64url, sent only in the cookie. The database stores
  its SHA-256, so a dump of the table signs nobody in. Idle timeout twelve hours (sliding,
  `last_seen_at` refreshed at most once a minute to avoid a write per request), absolute limit
  fourteen days from `created_at`. Expired rows are deleted on each sign-in and by a daily sweep.
- **Cookie**: `sim_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`. `Secure` is set when
  the browser reached the manager over HTTPS and only then, read from the request itself:
  `X-Forwarded-Proto: https` from the edge, which nginx forwards, or a TLS connection to the
  manager. It is left off over the plain HTTP of the SSH tunnel, because a browser drops a
  `Secure` cookie that did not arrive over TLS and the sign-in would loop. Parsed by a ten line
  function, no `cookie-parser`.
- **Cross-site request forgery**: three layers, all cheap. `SameSite=Lax` stops the browser
  sending the cookie on cross-site POSTs. Every non-GET request must carry
  `X-Requested-With: streaming-infra-manager`, a header a cross-origin page cannot add without a
  CORS preflight the API never grants (the manager sets no CORS headers, and this brief keeps it
  that way). And when `Origin` or `Sec-Fetch-Site` is present and says cross-site, the request
  is refused with 403.
- **Brute force**: an in-memory limiter in the single API process, keyed by username and by
  client IP (from `X-Forwarded-For`'s last hop, which nginx sets). Five failures start a lockout
  of one minute that doubles per further failure up to one hour. Locked answers 429 with
  `Retry-After`. Every failure is logged with username and IP. Successful sign-in resets the
  username key.
- **What stays open**: `GET /health` (Docker's healthcheck reads it, it returns `{status:'ok'}`
  and nothing else) and `POST /auth/login`. Everything else, including both Server-Sent Events
  streams, `/config`, `/metrics` and `/services`, requires a session. `EventSource` sends
  cookies on same-origin requests, so the live updates keep working unchanged.

### Endpoints

`manager/src/api/routes/auth.ts`, all JSON, all validated with yup:

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/auth/login` | `{ username, password }` | 204 and the cookie, 401 wrong pair, 429 locked, 409 `no_users` when none has been created |
| POST | `/auth/logout` | | 204, cookie cleared, session row deleted |
| GET | `/auth/session` | | `{ username, expiresAt }` or 401 |
| POST | `/auth/password` | `{ current, next }` | 204, all other sessions of the user revoked |
| GET | `/auth/users` | | `[{ id, username, createdAt, lastLoginAt, sessions }]` |
| POST | `/auth/users` | `{ username, password }` | 201, 409 taken |
| DELETE | `/auth/users/:id` | | 204, 409 for yourself or the last user |
| POST | `/auth/users/:id/revoke-sessions` | | 204 |

Middleware `requireSession` in `manager/src/api/middleware/requireSession.ts` runs before every
router in `server.ts` except the two open routes, attaches `req.user`, refreshes `last_seen_at`.
`requireSameSite` runs on every non-GET. The request logger logs the username, never the token.

### First user, with no secret in any file

There is no sign-up. The first user is created on the host, once, with a small CLI in the api
image:

```bash
docker compose exec -it api node dist/cli.js user:add levi
```

It prompts for the password twice with echo off and writes only the hash to Postgres. When
stdin is not a terminal it refuses, unless `--password-stdin` is given, which reads the password
from a pipe and lets 1Password supply it without the value ever landing in a file or an argv:

```bash
op read "op://<vault>/<item>/password" | docker compose exec -T api node dist/cli.js user:add levi --password-stdin
```

No `ADMIN_PASSWORD` environment variable and no seed file exist, deliberately. The manager
refuses to start any route but `/health` and `/auth/login` when the users table is empty, and the
sign-in page then says `No users yet. Create the first one on the host.` with the command.

### Frontend

- `app/useSession.ts`: on boot `GET /auth/session`, state `loading | signedOut | signedIn`.
  `http.ts` gains one fetch wrapper used everywhere that adds the `X-Requested-With` header on
  writes and turns any 401 into a `signedOut` transition with the "session ended" message.
  `EventSource` cannot set headers, it does not need to, it only reads.
- `auth/SignInPage.tsx` rendered by `App.tsx` instead of the shell while signed out.
- `Sidebar.tsx` footer: username and Sign out. `access/AccessPage.tsx` with the user table and
  the two forms. Route `#/access` in `router.ts`, nav item in `Sidebar.tsx`.
- Mock manager: `/auth/*` routes with one user `dev` and password `dev-password-1234`, an
  in-memory session set, the same lockout behaviour, so the whole flow is playable offline.

### Headers and HTTPS

`frontend/nginx.conf` adds, on every response:

```
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Frame-Options DENY always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

`style-src 'unsafe-inline'` is needed by MUI's emotion styles. Vite bundles every script, so
`script-src 'self'` holds. Links to deployments' own pages (viewer, SRS) open in new tabs and are
unaffected.

HTTPS (decision D1, recommended (a)): a new `edge` service in `manager/docker-compose.yml`,
image `caddy:2` pinned by digest, publishing `80` and `443`, with a five line Caddyfile:

```
{$MANAGER_DOMAIN} {
    encode zstd gzip
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    reverse_proxy web:80
}
```

`MANAGER_DOMAIN` comes from `manager/.env`. Caddy obtains and renews the Let's Encrypt
certificate itself, which needs an A record for the domain pointing at the host and ports 80 and
443 open. `web` keeps publishing `127.0.0.1:8080` as the break-glass path. Caddy sends
`X-Forwarded-Proto`, and nginx passes it on rather than overwriting it with its own plain `http`,
which is the whole of how the manager knows whether to mark the cookie `Secure`. Through the
tunnel there is no edge and no such header, so it is not marked, and both answers are the right
one for the transport in use.

As built: the service sits in the `public` compose profile with two named volumes for the
certificate, and `deploy.sh` adds `--profile public` when `MANAGER_DOMAIN` is set. Two things in
`frontend/nginx.conf` follow from having an edge at all. `set_real_ip_from` for the private ranges
the compose network is drawn from, so the last `X-Forwarded-For` hop is the browser rather than the
edge's own container address, which is the address the login lockout would otherwise blame for
everybody. And `limit_req` on `/auth/login` only, ten a minute per address with a burst of five,
because the manager's own lockout counts an attempt after it has paid for a scrypt, so a flood is
expensive before it is refused.

### What the API still hands to a signed-in user

Profile JSON carries each stream's private key and SRT passphrase, and `GET /config` the host
passphrase. Today that is by design: the operator needs the publish URL. Once several people
share the tool it is worth a follow-up that returns the key only on the deployment page and
never in the list. Noted, not in this PR.

## PR split

1. **Login gate**: migration, hashing, sessions, limiter, middleware, routes, CLI, sign-in page,
   Access page, mock, headers in nginx, docs. Nothing changes on the host until deployed.
2. **Edge**: the Caddy service and compose wiring, `deploy/deploy.sh` reading `MANAGER_DOMAIN`,
   the real client address and the sign-in rate limit in nginx, the host firewall generator script
   (below) and the runbook in `deploy/README.md`.

## Host steps, for Levi to run (decision D3)

**Superseded. Follow "Opening the manager to the internet" in
[../../deploy/README.md](../../deploy/README.md) instead.** That page has the current five steps
with the commands to run. What follows is the reasoning as it was set out on 2026-09-05, kept
because the order matters and the argument for it has not changed. Two of the steps have since
moved and are marked where they do.

1. Deploy the manager with PR 1. Create the first user with the CLI above. Sign in through the
   tunnel and confirm the gate before anything is opened.
2. Bind the node and engine APIs off the public interface. **Where these settings live has
   changed.** This step used to say they belong in `manager/swarm-hls-stream/.env` in the laptop's
   checkout, because a deploy rsynced that file to the host. A deploy no longer carries the stack
   at all, it carries one commit, and the submodule directory is excluded from the rsync, so an
   edit there now reaches nothing. They live on the server, in the bundled version's own config
   root, and are edited with the settings page or the editing script. There are five of them
   rather than two, because the engines publish three HTTP ports of their own.
   `deploy/README.md` step 2 names all five and how to edit them.

   The reasoning is unchanged. Set them to the Docker bridge address, never `127.0.0.1` for the
   Bee ports or OME's HLS port, because the manager reaches those through `host.docker.internal`,
   which is that same address, and loopback would cut off stamp management for every deployment
   on the host without saying so. Each node and engine picks the new binding up on its next
   deploy. **This step cannot be swapped for the firewall.** Docker publishes a container port by
   rewriting the destination and forwarding the packet, which never reaches the input hook a host
   firewall filters. The forward rules of step 3 do reach it, but they filter one way in where the
   bind closes the port outright.
3. Firewall, default deny inbound. Allowed: 22 (or `--ssh-port`), 80 and 443 TCP, and 443 UDP for
   the edge's HTTP/3. In the 10000 to 19999 band the stack uses, allowed only: TCP on the Bee P2P
   ports (last digit 6 and 8), TCP on the viewer ports (last digit 4), UDP on the SRT ingest ports
   (last digit 1), plus the second band `main-v3` uses for its per rung Bee nodes (11002, 11004,
   11006). Everything else in the band, above all the Bee APIs (5 and 7), the uploader API (0),
   the media server HTTP (3) and RTMP (2) and the SRS API (9), falls to the drop policy. PR 2
   ships `deploy/host/firewall-rules.sh`, which shifts each band by ten per slot up to
   `--max-slot` so nobody types three hundred port numbers by hand. It prints, it does not apply.
   `--max-slot` stops at 100 and refuses more: first-band slot 101 has its RTMP port on 11012,
   which is the second band's slot 1 P2P port, so above 100 the two bands cannot both be opened
   without opening RTMP with them.

   **What the generator emits has changed.** This step used to describe a second section of
   `DOCKER-USER` rules. It now prints one nftables table, `inet streaming_infra_manager`, with its
   own input and forward chains, and it replaces only that table. It also requires an inventory
   export that this step never mentioned: download `/targets/firewall?alias=<alias>` from the
   signed-in manager first and pass it as `--inventory`, or the script refuses to print. See
   `deploy/README.md` step 3 for the current command.

   The reasoning is unchanged, and it is why there are two chains. The input chain governs the
   host's own listeners and the whole stack when that runs with `COMPOSE_NETWORK=host`. The
   forward chain governs the ports Docker publishes for containers, which no input chain ever
   sees, and it matches the connection's original destination port because Docker has rewritten
   it by then. That chain needs the name of the external interface, passed as `--iface`, and the
   script refuses to print without it. So the three controls are: the API binds of step 2 close
   those ports at the source, the forward chain closes everything else that is published, and the
   input chain covers the host itself.

   **The per-rung band closed on 2026-09-16.** The step above lists a second band for the three
   per-rung Bee nodes. The generator opens it no longer, because this manager starts no rung
   service, so those 297 ports never carried a listener and now fall to the drop policy like every
   other private port. Four bands stay open, one per role: SRT ingest on UDP, the viewer page, and
   the two Bee peer ports, each for 100 slots. With the rung band gone, the slot-101 argument above
   is gone with it: `--max-slot` refuses anything above 100 because that is the manager's own slot
   cap, not because a second band would meet RTMP there. `deploy/README.md` step 3 carries the
   current wording, and a port the deployment page calls public has to be one of those four bands,
   which a test holds.
4. Point a DNS A record at the host, set `MANAGER_DOMAIN` in `manager/.env`, deploy PR 2.
   `deploy.sh` reads that name, adds `--profile public` so the edge starts, and says which of the
   two it did. Watch `docker compose logs -f edge` for the certificate, open the domain, sign in.
5. Keep the tunnel. `web` still publishes `127.0.0.1:8080`, which is the way back in when the edge
   is down, the certificate is stuck or the domain is wrong.

## Tests

- Unit (`node:test`, as the manager does today): hash and verify round trip, wrong password,
  stored parameters honoured, token hash never equals the token, cookie parser edge cases, the
  limiter's schedule (5 failures lock, doubling, cap, reset), the same-site check for each
  header combination, password policy, `requireSession` with an in-memory repository.
- Route level: the app started on a random port with an in-memory `SessionRepository`, `fetch`
  against it: login sets the cookie, a protected route without it is 401, with it 200, logout
  clears, a POST without `X-Requested-With` is 403.
- Browser pane against the mock: sign in, wrong password message, lockout message, sign out,
  session ended message after the mock revokes, Access page flows, dark mode.

## Done means

- Every route except `/health` and `/auth/login` answers 401 without a session, including both
  SSE streams.
- Passwords are scrypt hashes with recorded parameters. No plaintext password or session token
  appears in any file, log line, environment variable or the browser's JavaScript.
- Brute force locks and is logged. Cross-site POSTs are refused.
- The first user is created by the CLI with a hidden prompt or a pipe, never an env var.
- Security headers present on every response, checked in the Browser pane.
- Docs updated: `manager/README.md` loses "No auth", `deploy/README.md` gains the runbook.
- No new npm dependency in PR 1, and none in PR 2 either. PR 2 adds one image,
  `caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d`: the
  newest 2.x patch release, a Docker Official Image, published 2026-08-12 and so 25 days old when
  it was pinned, its index digest read back from the registry rather than taken from the tag page.
