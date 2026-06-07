## Streamer / Postage-Stamp Deploy Flow — Plan

Status: **planned, not yet implemented** (resume anchor for implementation).
Ticket: SPDV-1278. Branch: `feat/basic-server-diagnostic-SPDV-1278`.

## Problem

Deploying a **streamer** profile through the manager fails. The submodule's
`deploy/scripts/deploy.sh` has a `check_stamp` guard: if the service set
includes `stream-uploader` and `STAMP` is empty in the env file it reads, it
runs an **interactive** `read -r -p "Continue anyway? [y/N]"`. The manager runs
scripts with **stdin disabled** (`ScriptRunner` → `stdio: ['ignore', …]`), so
that prompt gets EOF → empty answer → `exit 1` "Aborted." A skippable warning
became a hard failure.

Original intent (confirmed in `manager/swarm-hls-stream/deploy/README.md`):

- A postage **stamp** = prepaid Swarm storage. Only `stream-uploader` needs it.
- Stamps are bought **on a running, funded bee node** (`node → fund → stamp:setup`).
- The stamp is **optional**: you can run the uploader without it (answer `y`),
  it just can't upload until a stamp exists.
- Viewers (`client` + `bee-gateway`) never need a stamp.

The streamer-through-manager path was likely never exercised before — only
viewers (e.g. `levigroup1-profile-1`, a viewer, runs fine).

## Constraints

- **Do NOT modify the `swarm-hls-stream` submodule.** All changes are in the
  manager (backend + frontend) and the manager's own `docker-compose.yml`.

## The one rule (mental model)

> The manager deploys **every service it can right now**. The only service with
> a prerequisite is `stream-uploader` (needs a usable stamp). If the
> prerequisite isn't met, the uploader is **held back** and shown as
> **"Stamp required"** while the rest of the stack runs. When a stamp is
> provided/bought, the uploader is deployed to complete the stack.

Stamp logic is driven by the **component set**, not the kind:
`needsStamp = components.includes('stream-uploader')`.

## Mechanism — how we avoid the interactive abort (no submodule edits)

The guard only fires when `stream-uploader` is in the list **and** the env file
it reads has empty `STAMP`. The manager controls both:

| Situation | Service list sent to `deploy.sh` | Extra | Guard |
| --- | --- | --- | --- |
| Components without uploader | as-is (no `stream-uploader`) | — | not triggered |
| Uploader, **no** usable stamp | set **minus** `stream-uploader` | — | not triggered |
| Uploader, **stamp** available | full set incl. `stream-uploader` | write `STAMP=` into `.env.<profile>` + pass `--stamp-id` | reads non-empty STAMP → no prompt |

Key facts (verified):

- `_lib.sh:37` defaults `ENV_FILE="$ROOT_DIR/.env"`; `_lib.sh:184-185` switches
  to `$ROOT_DIR/.env.<profile>` **if that file exists**. The manager currently
  does NOT create per-profile env files, so the guard reads base `.env` (empty
  STAMP). Writing `.env.<profile>` with `STAMP=…` makes the guard read that
  instead — clean and per-profile. (This is the submodule's intended design.)
- The real per-container stamp value still flows via the existing `--stamp-id`
  override (`_lib.sh` `parameter_overrides_text` → `.env.deploy`,
  `DeploymentOrchestrator.buildScriptArgs:315`).
- `check_stamp` is `deploy/scripts/deploy.sh:99-125`. `read` prompt at line 116.

## Locked decisions

1. **Hold the uploader back** (don't deploy) when no usable stamp — clean, no
   crash-loops; the bee node is up so a stamp can be bought, then deploy uploader.
2. Stamp management lives in a **new top-level "Uploaders" tab**.
3. Stamp ops use the **bee node HTTP API directly** from the manager (no CLI /
   pnpm / submodule `node_modules` — the api container has none of those).
4. Submodule untouched.

## "Stamp required" state

- Keep the profile status machine as-is (`DEPLOYING/RUNNING/STOPPING/STOPPED/REMOVING/ERROR`).
- Add a **derived** field on the profile API:
  `pendingStamp = needsStamp && !hasUsableStamp && uploaderNotRunning`.
- UI: "Stamp required" chip on the profile + the uploader row. Profile still
  reads RUNNING (it is — minus the uploader).
- Avoid adding a new status enum value (keeps the state machine simple).

## Stamp management — bee HTTP API mapping

Per profile, against its bee-uploader node:

| Action | Bee endpoint |
| --- | --- |
| Fund address | `GET /addresses` → `.ethereum` |
| Balances (xDAI / BZZ) | `GET /wallet` → `nativeTokenBalance` / `bzzBalance` |
| Stamp list | `GET /stamps` → `[{batchID, depth, amount, usable, batchTTL, utilization}]` |
| Buy stamp | `POST /stamps/{amount}/{depth}[?label=…]` (immutable via header) |
| Poll usable | `GET /stamps/{batchID}` → `usable`, `batchTTL` |

- **URL per profile:** `http://host.docker.internal:<BEE_UPLOADER_API_PORT>`,
  where `BEE_UPLOADER_API_PORT = 10005 + port_slot*10` (slot 1 → 10015).
- **Reachability:** add `extra_hosts: ["host.docker.internal:host-gateway"]` to
  the manager `api` service in `manager/docker-compose.yml` (one line, manager
  only) so the container can reach the host-published bee ports.
- Buy is async (~5 min to become usable) → background job + live status (reuse
  the SSE pattern from `events.ts` / metrics). On usable → set `stamp_id` →
  offer "Deploy uploader."

## Scenarios

### Viewer (`client`, `bee-gateway`) — no stamp ever
- First deploy → deploy both → RUNNING. Redeploy → idempotent `up`. Stamp UI hidden.

### Streamer (`srs`, `stream-uploader`, `bee-uploader`)
- **A. First deploy, no stamp:** deploy `srs` + `bee-uploader` (uploader held
  back). Profile RUNNING, `pendingStamp=true`, uploader row "Stamp required".
  srs runs (segments produced, none uploaded yet — its webhooks to the absent
  uploader will error in logs, benign). bee node is up → stamp can be bought.
- **B. Get a stamp:** (a) Uploaders tab → fund node address → buy stamp
  (amount/depth) → wait usable → manager sets `stamp_id`; or (b) paste a
  pre-bought `stamp_id` by editing the profile.
- **C. Deploy uploader:** write `STAMP` into `.env.<profile>`, deploy
  `stream-uploader` → `pendingStamp=false` → fully RUNNING.
- **D. First deploy WITH stamp (pasted at creation):** deploy all at once
  (guard satisfied) → fully RUNNING.
- **E. Redeploy, has stamp & running:** idempotent `up` of all → RUNNING.
- **F. Redeploy, still no stamp:** redeploy non-uploader services; uploader
  stays pending.
- **G. Stamp expired / out of funds:** stamp list shows not-usable → uploader
  row "Stamp expired"; user extends (top-up) or buys new → redeploy uploader.

### Custom (user-picked subset)
- `needsStamp` from actual components. Includes `stream-uploader` → behaves like
  Streamer; otherwise like Viewer.
- Edge: custom with `stream-uploader` but no `bee-uploader` → can't buy locally;
  UI warns + allow pasting an external `stamp_id`.

### Cross-cutting
- Stop: stop whatever runs. Remove: unchanged (`clean --yes`, already non-interactive).
- Groups: each member follows its kind's flow.

## Build order (phases — each independently useful)

### Phase 1 — Backend: unblock streamer deploy (fixes the immediate breakage)
- Service-aware split in `DeploymentOrchestrator`/`ProfileService`: if resolved
  services include `stream-uploader` and no usable stamp → deploy set minus
  `stream-uploader`.
- When a stamp is present: write `STAMP=` into `.env.<profile>` before deploying
  the uploader (new helper in `utils/envUtils.ts`).
- `pendingStamp` derived field on the profile API + `profile.changed` events.
- "Deploy uploader" action (incremental deploy of just `stream-uploader`).
- Files: `manager/src/domain/DeploymentOrchestrator.ts` (resolveServices ~320,
  buildScriptArgs ~301), `manager/src/domain/ProfileService.ts`,
  `manager/src/utils/envUtils.ts`, `manager/src/types/*`,
  `manager/src/api/routes/profiles.ts` (+ actions).
- Refs: `KIND_DEFAULT_SERVICES` in `manager/src/types/constants.ts`
  (streamer = `['srs','stream-uploader','bee-uploader']`).

### Phase 2 — Frontend: make the state clear
- "Stamp required" chip on profile + uploader row (Deployments & Resources).
- New-deployment drawer copy: "Stamp optional — deploy now, add it later."
- "Deploy uploader" button when `pendingStamp` and a stamp becomes available.
- Files: `frontend/src/DeploymentsTableRow.tsx`, `StatusChip.tsx`,
  `NewDeploymentDrawer.tsx`, `data.ts`, `types/*`.

### Phase 3 — Backend: stamp management via bee HTTP API
- Bee-API client in the manager (`/addresses`, `/wallet`, `/stamps`, buy, poll).
- Per-profile URL resolution (`host.docker.internal:<port>`), add `extra_hosts`
  to `manager/docker-compose.yml`.
- Endpoints: `GET /profiles/:name/stamp/address`, `…/wallet`, `…/stamps`,
  `POST …/stamp/buy` (async job + status), `POST …/stamp/set`.
- On buy usable → set `stamp_id` → auto-offer "Deploy uploader."

### Phase 4 — Frontend: "Uploaders" tab
- New tab listing uploader-bearing profiles. Per instance: node address (fund),
  balances (xDAI/BZZ), stamp list (id/depth/amount/usable/TTL), buy form
  (amount/depth/immutable), "Deploy uploader" button.

Phases **1 + 2** alone fix the broken streamer deploy. **3 + 4** add buy-from-UI.

## Notes / gotchas

- The api container is `node:22-alpine` + bash/jq/docker-cli/rsync/ssh — **no
  pnpm**, submodule bind-mounted **without `node_modules`**. Hence bee HTTP API,
  not the CLI.
- `bee-js` may be added as a manager dependency, or use plain `fetch` against the
  bee REST API (Node 22 has global fetch).
- Deploys are state-machine gated per profile (transitional states reset on boot
  via `resetOrphanedTransitions`). Incremental "deploy uploader" must fit that.
- Server is Ubuntu 22.04, cgroup v2, 48 cores / 270 GB. SSH alias: `manager-host`.
- Deploy: `./deploy/deploy.sh manager-host` (backend change → api recreated;
  frontend-only → only web recreated).
- Earlier in SPDV-1278 the submodule runtime files (`.env`, `deploy/config.json`)
  get wiped by `rsync --delete` each deploy and are recreated by
  `bootstrapSubmoduleDefaults` — now called before every profile action in
  `DeploymentOrchestrator` (commit 74e86ad). The `.env.<profile>` write in
  Phase 1 must coexist with that (don't let bootstrap or rsync clobber it
  mid-flow).
