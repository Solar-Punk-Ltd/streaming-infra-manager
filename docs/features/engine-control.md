# Engine control: SRS and OvenMediaEngine from the UI

Status: decided 2026-09-05 (D7 backport wanted, D8 SRS first). D12 is on hold, so PR 1 (settings,
restart, logs, effective config) proceeds and PR 2 (live status) waits for the upstream port change.

PR 1 was built on `feat/engine-control`, went in with pull request #40, and is merged to
`main-v2`. It was written against the stack as pinned at the time, `main-v2` `ee99c36`. The
submodule tracked `main-v3` from 2026-09-09, then `feat/manager-line`, the manager's own line of
the stack, from 2026-09-17, and has tracked `main` since 2026-09-19, when that line reached the
stack's `main` as PR #241. Its pin has moved several times since, which the update below explains.
`SRT_LATENCY` was left out with the rest of what a later stack reads, until it became a setting on
2026-09-23, see the update of that date below. PR 2 is not started.

Update 2026-09-09: the bundled stack is now `main-v3` (Levi's ruling: main-v3 is the default,
main-v2 is obsolete and kept only to test version selection). `main-v3` already publishes
`SRS_HTTP_API_PORT`, so the D7 backport to `main-v2` described below is no longer needed, and
PR 2 (live status) waits only on the manager reading that port. The manager still answers
`live: null` for it, with the reason "not read yet".

Update 2026-09-23, on `fix/srt-latency-setting` off `main` at `87673c9`, commits `5a5373d`,
`6a37c2a` and `f42fba2`: `SRT_LATENCY` is an SRS setting like the others. On 2026-09-22 an outside
broadcaster's recording came out with broken blocks of picture. SRS's own SRT counters showed 5 to
8.5% of the packets lost and nearly all of them resent, but the resends arrived after the latency
window, so SRS dropped them and each drop became a hole in a frame. The engine settings offer it as
**SRT latency**, in whole milliseconds from 20 to 10000, and the owner decided on 2026-09-23 that it
defaults to 2000.

That default is the manager's own and not the stack's. `v3.1`, which the manager pinned from
2026-09-19 to 2026-09-24, falls back to 200, as does every version cut before the decision that reads the key at
all (`main-v2` does not). The stack's `main` has fallen back to 2000 itself since its PR #244, which
its releases `v3.2`, `v3.3` and `v3.4` carry, and the manager has pinned it since 2026-09-24. On every version the manager writes
`SRT_LATENCY=2000` into `.env.<profile>` for every SRS deployment that stores no value. The Engine
card calls it **Manager default**, and the Stack settings card names it as the manager's own
default. It is the only setting written while unset. A value set in the host's base `.env` still
wins, as it does for every other setting, and both then say it was set on this host. A deployment
that stores no value gets `SRT_LATENCY=2000` the next time its env file is written, on its next
deploy, an Apply of its settings included. Whether SRS then waits that long on ingest depends on the
version's template, which the next paragraph explains.

Measured 2026-09-23 on the stack's `fix/srt-ingest-latency` branch, head `a1b43f0a`. SRS 6 applies
`latency` to both directions and `recvlatency` after it, and falls back to 120 for `recvlatency`
when the block leaves it out, so `recvlatency` alone decides SRS's side of the wait on ingest. With
libsrt 1.5.4 over loopback, the options applied in SRS's order, `latency 2000` with `recvlatency`
unset negotiated 120 ms, `latency 2000` with `recvlatency 2000` gave 2000, and a caller asking for
3000 got 3000, because SRT uses the larger of the two ends' values. The stack now sets both: since
`36b6749f` on that branch its template fills `SRT_LATENCY` into `latency` and `recvlatency` alike.
The recording of 2026-09-22 was therefore made through SRS's own 120 ms, not the 200 the stack
asked for, as the stack's notes at `a1b43f0a` now say.

Until 2026-09-24 the manager pinned `v3.1` at `2c4867a`, which fills `latency` alone, so a deployment
on the bundled version then waited 120 ms on ingest whatever `SRT_LATENCY` said. Since 2026-09-24 the
pin, now the stack's release `v3.4`, carries `36b6749f`, so the bundled version waits the
setting on ingest. A deployment runs from a copy of the build it was last deployed from, so one on
the bundled version moves onto that template on its next deploy. The Engine card reads the template
of the version's current build rather than that copy, so it shows the setting from the moment the
host has built a pin that carries it, `v3.3` or `v3.4`. `v3.1` and the stack's tags before it keep waiting
SRS's own 120. For a deployment with a config file of its own the manager reads `recvlatency` as
[engine-config.md](engine-config.md) describes. From later on 2026-09-23 it reads the SRT latency
off the version's template for a deployment that runs that template as well. On a template that
fills `recvlatency`, as the bundled one does, the Engine card shows the stored value, or the
default with its source, which is **Manager default** unless the host sets one. On a template that
fills only `latency`, as `v3`'s and `v3.1`'s do, it shows SRS's own 120 as **Engine default**, with
the sentence that SRS ignores `latency` for ingest without `recvlatency`, and the setting's row in
the Stack settings card says a value there has no effect on this version. A template that
never takes the setting is read at its own `srt_server` block, since `435ee1d`. The stack's `v1`
and `v2` (`12632b50`) are such versions: their templates write `latency 200` themselves and no
`recvlatency`, and their entrypoints never read `SRT_LATENCY`. On them the Engine card shows
SRS's own 120 as **Engine default**, with the sentence that this stack version does not read the
setting and that its template decides the wait on ingest, and a `recvlatency` such a template wrote
would be shown as the wait instead. The manager still writes `SRT_LATENCY=2000` into
`.env.<profile>` there, where nothing reads it. Every other setting of such a deployment is still
read as the environment, because the template fills each from it. The offline mock reads its own
template, a copy of `v3.1`'s, the same way, so it shows `v3.1`'s 120 rather than the bundled
stack's wait.

Update 2026-09-23, on `feat/srt-ingest-health`: the SRT link's own packet counts, lost,
retransmitted and dropped over the last minute, are read out of the SRS container's log and
shown on a card of their own, because SRS's HTTP API does not expose them. That is not the live
status of PR 2, which is still not built. See [srt-ingest-health.md](srt-ingest-health.md).

Update 2026-09-26, on `feat/deployment-settings-engine` up to `02f699d4`: the Engine card's
settings drawer is gone. Levi ruled that day that a deployment has one list of settings, so its
engine settings are edited in the deployment's **Stack settings** card, in an **Engine settings**
section of their own at the top of its list, with the fields, defaults, help and rules the drawer
had. A save there stores and recreates nothing, and Apply recreates the containers that read what
changed: the engine for an engine setting, the engine and the uploader for the segment length, and
the uploader alone for the OvenMediaEngine poll interval, which only the uploader reads.
[deployment-settings.md](deployment-settings.md) describes the card. The Engine card keeps its list
of what the engine runs with and where each value came from, and its config file dialog, and its
**Settings** button brings that section into view with its first setting focused. The engine
settings are still stored in `profiles.engine_settings`. `PUT /profiles/:name/engine-settings`
stays, as the way scripts save and recreate in one call, and since that day it moves the settings
revision the card saves under and is refused, rather than overwriting, when a save from the card
landed after it read the settings.

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
- **Settings** brings the deployment's **Stack settings** card into view with its **Engine
  settings** section open and the first setting focused (since 2026-09-26, a drawer of its own
  before). That section has only the fields the engine has. For SRS: **Segment length**
  (`HLS_FRAGMENT`, seconds), **Force-close a piece after** (`HLS_SEGMENT_MAX`, seconds), **Playlist
  window** (`HLS_WINDOW`, seconds), **SRT latency** (`SRT_LATENCY`, milliseconds, since 2026-09-23,
  whose default is the manager's own as the update above says), and on an ABR uploader alone the
  transcoding settings: frame rate, preset, profile, threads, audio codec, audio bitrate, VBV
  seconds (`ABR_FPS`, `ABR_PRESET`, `ABR_PROFILE`, `ABR_THREADS`, `ABR_ACODEC`,
  `ABR_AUDIO_BITRATE`, `ABR_VBV_SECONDS`). The ladder itself stays fixed, it is the contract with
  the node pool. For OME: **Segment duration** and **Segment count** (`HLS_SEGMENT_DURATION`,
  `HLS_SEGMENT_COUNT`), **Poll interval** (`OME_HLS_POLL_INTERVAL_MS`). Each field is named by its
  label with the key beside it, shows its unit, the default an unset one falls back to on this
  host, and a one line explanation from the stack's sample files. The card validates what the
  entrypoint validates: positive numbers, integers where required, a ceiling at or over the
  segment length, and for ABR `frame rate × segment length` must be a whole number or the engine
  refuses to start. A pair it would refuse is named once above Save, which stays off. A save
  stores and recreates nothing, and the card's Apply recreates the containers that read what
  changed: the engine, the uploader with it for the segment length, and the uploader alone for
  the poll interval. Until 2026-09-26 the drawer's Save, **Apply and recreate engine**, stored
  and recreated in one step.
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
join it only if Levi asks. Creating a group is the other door and it does carry them: `POST
/groups` takes `engine_settings` and writes them to every member, and a member added later
takes what its siblings run. So a group starts on one segment length even though it cannot yet
be moved to another in a single write.

## Manager changes

### Settings storage and deploy

Migration `009_engine_settings.sql`: `ALTER TABLE profiles ADD COLUMN engine_settings JSONB NOT
NULL DEFAULT '{}'::jsonb`. One column rather than nine, because the set differs per engine and per
stack version, and validation lives in code:

- `common/src/engineSettings.ts`, new, tested: the field list per engine (`SRS_SETTINGS`,
  `OME_SETTINGS`) with key, label, unit, kind (`number | integer | choice`), default, min, max,
  help text and, for a field the engine's config template carries, the placeholder its value
  fills. Which keys a version reads comes from that version's contract, not from the field.
  `engineSettingsProblem
  (engine, settings)` returns the first human readable problem or null, including the GOP rule.
  `engineSettingsEnv(engine, settings)` returns the `KEY=value` pairs to write. Shared, so the
  settings page, its save and the deploy validate identically. Since 2026-09-23 it takes the host's defaults as
  well and adds a default the manager owns, `managerOwnsDefault` on the field, for a key the
  deployment does not store and the host's base `.env` does not set. `SRT_LATENCY` is the only
  such field.
- `writeProfileEnv` writes those pairs (every value goes through the same character check the
  passphrase gets, because it lands inside a `sed` expression in the entrypoint).
- `effectiveEnvOf` reads the keys back from the env file the deploy wrote, and `containerKeysSpec`
  records them against each container, so the container snapshot shows what the engine was
  started with. The file's engine lines come from `engineSettingsEnv` with the host's defaults
  since 2026-09-23, so the snapshot names the manager's SRT latency exactly when the file carries
  it.
- `ProfileService.updateEngineSettings(name, settings)`: refuses while the profile is
  transitional, stores, then `orchestrator.startDeploy(profile, [engine])` for the engine service
  only. The profile goes `DEPLOYING` and back like any deploy, and the existing SSE events carry
  it to the UI. Since 2026-09-26 it reads the stored settings with their settings revision first,
  moves that revision with its write, and refuses with `engine_settings_changed` when a save from
  the Stack settings card moved it in between.
- Route `PUT /profiles/:name/engine-settings` with a yup schema built from the field list. Since
  2026-09-26 it is the way scripts save and recreate in one call. The page saves through the
  deployment's settings routes instead. Its body replaces the whole set, so a key neither engine
  reads is refused by name, its value never repeated, rather than dropped into a reset of the
  setting it meant.

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
  SRS config contains the SRT passphrase in clear. Since the passphrase left the profile JSON on
  2026-09-16 this route is one of the two doors the value leaves by, so it logs who read which
  deployment's config, and the response is marked no-store.

Routes, `manager/src/api/routes/engine.ts`:

| Method | Path | Answer |
|---|---|---|
| GET | `/profiles/:name/engine` | `{ engine, abr, settings, defaults, fields, live, liveUnavailableReason }`, where `live` is null in PR 1 and `liveUnavailableReason` says why |
| PUT | `/profiles/:name/engine-settings` | 202, the profile. For scripts since 2026-09-26. 400 `validation_error` naming a key neither engine reads |
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
backport is a cherry-pick with conflicts resolved by hand. The manager side no longer needs a mirror: the stack versions work landed, so the port table
comes from the selected version's own contract (`manager/src/domain/versions/portTable.ts`),
and `containerKeysSpec` already carries `SRS_HTTP_API_PORT`.

The SRS API has an optional Basic auth block (`http_api { auth { enabled on; username;
password; } }`). Once the port is published it is one more unauthenticated port on the host,
covered by the firewall rules in [auth-and-public-access.md](auth-and-public-access.md) (last
digit 9 is dropped there). Enabling the auth block with a manager generated password per
deployment is a small follow-up and is listed as such, not in this round.

OME (D8): live status would need a `<Managers>` block in the template, a port and an access token
generated per deployment and stored like the passphrase. Not in this round. The card shows the
settings, restart, logs and effective config for OME regardless.

## Frontend changes

- `deployments/EngineCard.tsx`, `deployments/engineApi.ts`, `deployments/LogsDialog.tsx` with
  the config tab, confirm dialogs through the existing `ConfirmDialog`. The settings were edited in
  `forms/EngineSettingsDrawer.tsx` until 2026-09-26, and since then in the Stack settings card,
  `deployments/settings/`, with fields rendered from the shared list and validation from
  `engineSettingsProblem`.
- `useDeploymentActions` gains `restartContainer(name, service)` with its toast. `EditorsContext`
  gained `openEngineSettings(name)`, which went with the drawer: the Engine card's Settings button
  asks the deployment page to show the engine settings in the Stack settings card instead.
- `AtAGlanceCard` shows `Engine: SRS · segment 2 s · window 15 s` for a deployment created with
  the manager's own defaults, off the same observations the engine card reads, so a deployment
  that stores neither shows whatever its own stack version falls back to instead.
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
- Browser pane against the mock: change the segment length in the Stack settings card, save,
  Apply, and watch the deployment go Deploying and back, restart with and without a publisher,
  logs dialog, config tab, dark mode, the live block on a running stream and its "not published"
  sentence on an old version.

## Done means

- Engine settings are edited in the deployment's Stack settings card (a drawer of their own until
  2026-09-26) with this host's defaults and the stack's help, validated the way the entrypoint
  validates, applied by recreating the containers that read what changed, and visible in the
  container snapshot afterwards.
- Restart, logs and effective config work for srs, stream-uploader and bee-uploader on a running
  deployment, and answer plainly when the container is not running.
- PR 2: a running stream shows publisher, codec, resolution, bitrate and uptime, refreshed while
  the page is open, and the ABR loop signal is red when the stream count climbs.
- Typecheck, build, tests green. No new npm dependency. No em-dashes or semicolons in copy.
