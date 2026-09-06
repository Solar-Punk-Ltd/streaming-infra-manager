# Sign in, and opening the manager to the internet

Status: decided 2026-09-05 (D1 Caddy, D2 several users, D3 close the host doors first). In
progress on `feat/auth` since 2026-09-06. Two PRs against `main-v2`, then host steps that only Levi
runs.

## Where we are

The manager has no authentication of any kind. Its own README lists it under limitations as "No auth" with
"deploy behind a firewall" as the advice. On the host the `web` container (nginx serving the frontend and
proxying the API) publishes only `127.0.0.1:8080`, the `api` container publishes nothing, and the
team reaches the UI through an SSH tunnel. Postgres is bound to loopback.

Making the manager public therefore has three parts, and the login is the smallest of them:

1. **A login gate in the manager.** Users, passwords, sessions, a sign-in page, and every API
   route behind it. This brief's first PR.
2. **HTTPS in front.** A password over plain HTTP is a password given away. Decision D1.
3. **Closing the other doors.** The stack the manager deploys publishes ports on the host with no
   authentication: every Bee node's API (10005 and 10007 plus slot times 10), which can buy stamps
   and, with a whitelist, send the node's money away, the uploader's API (10000 plus slot times
   10), which accepts segments that spend postage, and the media server's HTTP port. Today these
   are open to the internet already, unless the host has a firewall nobody has written down
   (the host state has not been read since 2026-08-04). A login on the manager does nothing for
   them. Decision D3, and the host steps at the end of this brief.

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
443 open. `web` stops publishing `127.0.0.1:8080` once the edge works, or keeps it during the
transition. Caddy sends `X-Forwarded-Proto`, and nginx passes it on rather than overwriting it
with its own plain `http`, which is the whole of how the manager knows whether to mark the cookie
`Secure`. Through the tunnel there is no edge and no such header, so it is not marked, and both
answers are the right one for the transport in use.

### What the API still hands to a signed-in user

Profile JSON carries each stream's private key and SRT passphrase, and `GET /config` the host
passphrase. Today that is by design: the operator needs the publish URL. Once several people
share the tool it is worth a follow-up that returns the key only on the deployment page and
never in the list. Noted, not in this PR.

## PR split

1. **Login gate**: migration, hashing, sessions, limiter, middleware, routes, CLI, sign-in page,
   Access page, mock, headers in nginx, docs. Nothing changes on the host until deployed.
2. **Edge**: the Caddy service and compose wiring, `deploy/deploy.sh` passing `MANAGER_DOMAIN`,
   the host firewall generator script (below) and the runbook in `deploy/README.md`.

## Host steps, for Levi to run (decision D3)

These are listed here because the host is a gated deploy. In order:

1. Deploy the manager with PR 1. Create the first user with the CLI above. Sign in through the
   tunnel and confirm the gate before anything is opened.
2. Bind the Bee APIs to the Docker bridge instead of every interface. The stack already has the
   knobs: set `BEE_UPLOADER_API_BIND` and `BEE_GATEWAY_API_BIND` in the stack's base `.env` on the
   host to the bridge address (`ip -4 addr show docker0`, usually `172.17.0.1`). The manager
   reaches the nodes through `host.docker.internal`, which is that same address, so nothing the
   manager does changes. The viewer's nginx proxies the gateway by service name, also unchanged.
   Each Bee node picks the new binding up on its next deploy from the UI.
3. Firewall, default deny inbound. Allowed: 22, 80, 443. In the 10000 to 19999 band the stack
   uses, allowed only: TCP on the Bee P2P ports (last digit 6 and 8), TCP on the viewer ports
   (last digit 4), UDP on the SRT ingest ports (last digit 1). Everything else in the band,
   above all the Bee APIs (5 and 7), the uploader API (0), the media server HTTP (3) and RTMP (2),
   is dropped. PR 2 ships `deploy/host/firewall-rules.sh`, which prints the nftables set for
   slots 1 to 99 (and the second band 11001 to 11006 that `main-v3` uses) so nobody types 300
   port numbers by hand. It prints, it does not apply.
4. Point a DNS A record at the host, set `MANAGER_DOMAIN`, deploy PR 2, watch Caddy obtain the
   certificate, open the domain, sign in.
5. Remove the port 8080 publish and the tunnel from the runbook, or keep the tunnel as the
   break-glass path.

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
- No new npm dependency in PR 1. PR 2 adds the `caddy:2` image pinned by digest, with the
  provenance check the dependency rule requires recorded in the PR.
