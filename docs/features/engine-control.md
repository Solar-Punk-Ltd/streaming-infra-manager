# Engine control: SRS and OvenMediaEngine from the UI

Status: decided 2026-09-05 (D7 backport wanted, D8 SRS first). D12 is on hold, so PR 1 (settings,
restart, logs, effective config) proceeds and PR 2 (live status) waits for the upstream port change.

PR 1 is built on `feat/engine-control`, against the stack as pinned today (`main-v2`, `ee99c36`).
`SRT_LATENCY` is left out with the rest of what a later stack reads. PR 2 is not started.

Update 2026-09-09: the bundled stack is now `main-v3` (Levi's ruling: main-v3 is the default,
main-v2 is obsolete and kept only to test version selection). `main-v3` already publishes
`SRS_HTTP_API_PORT`, so the D7 backport to `main-v2` described below is no longer needed, and
PR 2 (live status) waits only on the manager reading that port. The manager still answers
`live: null` for it, with the reason "not read yet".

## What the engines are and how they are configured today

A stream deployment runs a media server that takes the SRT feed from OBS and cuts it into HLS
segments for the uploader. Two engines exist: SRS (the default) and OvenMediaEngine, OME (disabled
in the stack by default, no deployment uses it today). Each runs from a stock image with a
template config and an entrypoint script from the stack (`engines/srs/srs.conf.template` and
`entrypoint.sh`, `engines/ome/Server.xml.template` and `entrypoint.sh`). At container start the
script fills the template from environment variables and refuses to start on a value it cannot
splice safely.

Those environment variables reach the container from compose interpolation of three files the
deploy script assembles: the profile's `.env.<profile>` (written fresh by the manager on every
deploy from the database, the root file wins on duplicate keys), the engine's own
`engines/srs/.env.<profile>` (created once from the sample, never touched by the manager), and a
per deploy override file with the resolved ports and hostnames. So "changing an engine setting"
means: store it in the database, write it into `.env.<profile>` like the passphrase already is,
and recreate the engine container, which `deploy.sh --profile <name> srs` already does. Nothing
about the templates has to change for settings and restarts.

What does not exist today:

- **Live status.** SRS has an HTTP API (`/api/v1/summaries`, `/api/v1/streams`, `/api/v1/clients`,
  `/api/v1/versions`) on port 1985 inside the container. The template enables it, and the compose
  file of the current stack (`main-v2`) does not publish it, so nothing outside the container can
  read it. `main-v3` publishes it per deployment as `SRS_HTTP_API_PORT`, 10009 plus slot times 10,
  the last free digit in the port table. The manager in its own container cannot reach a port
  that is not published: the profile's compose network is separate from the manager's, and Docker
  does not route between bridges.
- **SRS console.** The SRS image ships a web console under its HTTP server, but the stack mounts
  the media volume over that directory, so the console is not served on any deployment. There is
  no SRS web page to link to, only the API.
- **OME API.** OME has a REST API secured by an access token (a `<Managers>` block in
  `Server.xml` with an `<API><AccessToken>`, sent as HTTP Basic auth), but the stack's template
  has no such block, so it is off. OME has no restart or reload call, its API refuses to modify
  anything declared in `Server.xml`, and its docs do not promise that apps created through the
  API survive a restart. Everything here therefore goes through the template and a recreate,
  for OME exactly as for SRS.
- **Restart.** Only Stop and Start of the whole deployment. Restarting one container means the
  Docker API, which the manager already uses for metrics, on the container whose compose labels
  are `project=<profile>` and `service=srs`.
- **Logs and the effective config.** Both are one Docker API call away (`logs`, and `exec cat` on
  the generated `srs.conf`), and neither is exposed.

## What the operator sees

A new **Engine** card on the deployment page of every stream and ABR uploader, between Publish
and Storage:

- Header: `SRS 6 · media server` or `OvenMediaEngine`, a status pill, and three buttons:
  **Settings**, **Restart**, **Logs**.
- **Live** (when the API is reachable, PR 2): `Publishing now: live/stream, 1080p60, 5.9 Mbps
  video, 128 kbps audio, since 14:02` or `No publisher connected`. For the ABR ladder: `5 streams,
  1 source and 4 rungs`, red when the count keeps climbing, because that is the transcode loop
  the stack's README warns about. Then `SRS uptime 3d 4h · 2 HTTP clients`. Refreshed every five
  seconds while the page is open. When the API is not reachable the block says `Live status
  needs the SRS API port, which this stack version does not publish.`
- **Settings** opens a right drawer, the same frame the Edit drawer uses, with only the fields
  the engine has. For SRS: **Segment length** (`HLS_FRAGMENT`, seconds), **Playlist window**
  (`HLS_WINDOW`, seconds), **SRT latency** (`SRT_LATENCY`, milliseconds, `main-v3` only), and
  under **Transcoding (ABR uploaders only)**: frame rate, preset, profile, threads, audio codec,
  audio bitrate, VBV seconds (`ABR_FPS`, `ABR_PRESET`, `ABR_PROFILE`, `ABR_THREADS`, `ABR_ACODEC`,
  `ABR_AUDIO_BITRATE`, `ABR_VBV_SECONDS`). The ladder itself stays fixed, it is the contract with
  the node pool. For OME: **Segment duration** and **Segment count** (`HLS_SEGMENT_DURATION`,
  `HLS_SEGMENT_COUNT`), **Poll interval** (`OME_HLS_POLL_INTERVAL_MS`). Each field shows the
  stack default and a one line explanation copied from the stack's sample files (for example
  "SRS can only cut on a keyframe, keep the publisher's GOP at or below this"). The drawer
  validates what the entrypoint validates: positive numbers, integers where required, and for
  ABR `frame rate × segment length` must be a whole number or the engine refuses to start. Save
  is labelled **Apply and recreate engine** and the drawer says what that does: `Recreates the
  SRS container with the new values. A live publisher is disconnected for a few seconds and
  reconnects on its own if OBS is set to retry.`
- **Restart** asks first: `Restart SRS for stream1? The publisher (if any) is disconnected for a
  few seconds. Settings are not changed.` With live status available the dialog says whether a
  publisher is connected right now.
- **Logs** opens a dialog with the last 200 lines of the engine container, a Refresh button and a
  service switch (srs, stream-uploader, bee-uploader) so the same dialog serves the whole stack.
- **Effective config** (inside the Logs dialog as a second tab): the generated `srs.conf` as the
  container is running it, read-only, with a copy button. It is the fastest way to see which
  values actually applied.

Group page for a standard group of streams: **Apply engine settings to all** is not in this
round. Groups share settings through the existing shared settings drawer, and engine settings
join it only if Levi asks.

## Manager changes

### Settings storage and deploy

Migration `009_engine_settings.sql`: `ALTER TABLE profiles ADD COLUMN engine_settings JSONB NOT
NULL DEFAULT '{}'::jsonb`. One column rather than nine, because the set differs per engine and per
stack version, and validation lives in code:

- `common/src/engineSettings.ts`, new, tested: the field list per engine (`SRS_SETTINGS`,
  `OME_SETTINGS`) with key, label, unit, kind (`number | integer | choice`), default, min, max,
  help text, and `whichVersions` for fields that only newer stacks read. `engineSettingsProblem
  (engine, settings)` returns the first human readable problem or null, including the GOP rule.
  `engineSettingsEnv(engine, settings)` returns the `KEY=value` pairs to write. Shared, so the
  drawer and the deploy validate identically.
- `writeProfileEnv` writes those pairs (every value goes through the same character check the
  passphrase gets, because it lands inside a `sed` expression in the entrypoint).
- `buildEffectiveEnv` and `containerKeysSpec` include the keys, so the container snapshot shows
  what the engine was started with.
- `ProfileService.updateEngineSettings(name, settings)`: refuses while the profile is
  transitional, stores, then `orchestrator.startDeploy(profile, [engine])` for the engine service
  only. The profile goes `DEPLOYING` and back like any deploy, and the existing SSE events carry
  it to the UI.
- Route `PUT /profiles/:name/engine-settings` with a yup schema built from the field list.

### Restart, logs, effective config

`manager/src/domain/ContainerControl.ts`, new, dockerode, the same socket the metrics collector
uses:

- `find(profile, service)`: `listContainers` filtered by the two compose labels, error
  `ContainerNotRunningError` (409) when absent.
- `restart(profile, service)`: `container.restart({ t: 10 })`. Allowed services: the engine,
  `stream-uploader`, `bee-uploader`. Bee is included because a stuck node is the other thing an
  operator restarts, and the route is the same. The profile status does not change, this is
  below the deploy state machine, but an activity line is published on the event bus:
  `engine.restarted { profile, service }`.
- `logs(profile, service, tail)`: `container.logs({ stdout, stderr, tail, timestamps })`,
  demultiplexed, capped at 2000 lines, returned as text.
- `effectiveConfig(profile)`: `container.exec` with `cat /usr/local/srs/conf/srs.conf` (SRS) or
  `cat /opt/ovenmediaengine/bin/origin_conf/Server.xml` (OME), captured, capped at 256 KiB. The
  SRS config contains the SRT passphrase in clear, which the profile JSON already carries, so
  nothing new leaks, but the response is marked no-store.

Routes, `manager/src/api/routes/engine.ts`:

| Method | Path | Answer |
|---|---|---|
| GET | `/profiles/:name/engine` | `{ engine, abr, settings, defaults, fields, live, liveUnavailableReason }`, where `live` is null in PR 1 and `liveUnavailableReason` says why |
| PUT | `/profiles/:name/engine-settings` | 202, the profile |
| POST | `/profiles/:name/containers/:service/restart` | 202 |
| GET | `/profiles/:name/containers/:service/logs?tail=200` | `text/plain` |
| GET | `/profiles/:name/engine/config` | `text/plain`, no-store |

### Live status (PR 2, after decision D7)

`manager/src/domain/SrsApiClient.ts`: `summaries()`, `streams()`, `clients()`, `versions()`
against `http://<LOCAL_BEE_HOST>:<SRS_HTTP_API_PORT>`, the same host resolution
`beeApiUrlFor` uses, three second timeout. The port comes from the container snapshot (`ports.
SRS_HTTP_API_PORT`) when present and is otherwise absent, which is how the route knows to answer
`live: null` with the reason. `GET /profiles/:name/engine` fills `live` with the publisher
stream (name, video codec, width, height, fps, kbps), stream count, client count and uptime. The
frontend polls it every five seconds while the card is visible.

The upstream change this needs on `main-v2` (D7), in swarm-hls-stream: add `SRS_HTTP_API_PORT:
10009` to `PORT_VARS` in `deploy/scripts/_lib.sh`, publish
`${SRS_HTTP_API_PORT:-1985}:${SRS_HTTP_API_PORT:-1985}` in `deploy/docker-compose.yml`, pass it
into the container environment, and make the template's `http_api { listen }` a placeholder the
entrypoint fills. That is what `main-v3` already has (commit range `bbfb8bf..be440d6`), so the
backport is a cherry-pick with conflicts resolved by hand. The manager side mirrors the new port
in `PORT_VAR_DEFAULTS` and `containerKeysSpec`, until [stack-versions.md](stack-versions.md)
makes that table come from the stack version.

The SRS API has an optional Basic auth block (`http_api { auth { enabled on; username;
password; } }`). Once the port is published it is one more unauthenticated port on the host,
covered by the firewall rules in [auth-and-public-access.md](auth-and-public-access.md) (last
digit 9 is dropped there). Enabling the auth block with a manager generated password per
deployment is a small follow-up and is listed as such, not in this round.

OME (D8): live status would need a `<Managers>` block in the template, a port and an access token
generated per deployment and stored like the passphrase. Not in this round. The card shows the
settings, restart, logs and effective config for OME regardless.

## Frontend changes

- `deployments/EngineCard.tsx`, `deployments/engineApi.ts`, `forms/EngineSettingsDrawer.tsx`
  (fields rendered from the shared list, validation from `engineSettingsProblem`),
  `deployments/LogsDialog.tsx` with the config tab, confirm dialogs through the existing
  `ConfirmDialog`.
- `EditorsContext` gains `openEngineSettings(name)`. `useDeploymentActions` gains
  `restartContainer(name, service)` with its toast.
- `AtAGlanceCard` shows `Engine: SRS · segment 1.5 s · window 22.5 s`.
- Mock manager: engine settings stored per profile and echoed, restart bumps a fake uptime,
  logs and config return generated text, live status invents a publisher for running streams.

## PR split

1. **Settings, restart, logs, effective config.** No upstream dependency, works on the stack as
   pinned today.
2. **Live status.** After the `SRS_HTTP_API_PORT` backport lands upstream and the submodule pin
   moves (or as part of the versions work if D7 picks (b)).

## Tests

- `common`: every SRS and OME field's default passes its own validation, the GOP rule refuses
  `25 × 1.5` and accepts `30 × 1.5`, out of range and non numeric values named, env rendering
  stable.
- `manager` unit: `writeProfileEnv` carries the settings, refuses a value with `/` or `&`,
  `ContainerControl.find` matches on both labels and not on one, restart refuses an unknown
  service, logs are demultiplexed and capped (a stubbed dockerode).
- Browser pane against the mock: change segment length, watch the deployment go Deploying and
  back, restart with and without a publisher, logs dialog, config tab, dark mode, the live block
  on a running stream and its "not published" sentence on an old version.

## Done means

- Engine settings are edited in a drawer with the stack's own defaults and help, validated the
  way the entrypoint validates, applied by recreating only the engine, and visible in the
  container snapshot afterwards.
- Restart, logs and effective config work for srs, stream-uploader and bee-uploader on a running
  deployment, and answer plainly when the container is not running.
- PR 2: a running stream shows publisher, codec, resolution, bitrate and uptime, refreshed while
  the page is open, and the ABR loop signal is red when the stream count climbs.
- Typecheck, build, tests green. No new npm dependency. No em-dashes or semicolons in copy.
