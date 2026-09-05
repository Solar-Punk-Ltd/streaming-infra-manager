# Frontend UX rework

Status: in progress on `feat/ux-rework`, targeting `main-v2`. Decided 2026-09-05 from the
clickable mockup in [redesign-mockup.html](redesign-mockup.html) (open it in a browser, it runs
on fake data and every button works).

This document is the implementation brief. It says what the operator sees, how each screen maps
onto the manager API that already exists, and which files change. Nothing here needs a backend
change.

## Why

The current UI splits one deployment across three tabs. Status lives in Deployments, the publish
URL and the postage stamp in Uploaders, CPU in Resources. Getting a stream ready means hopping
tabs four or five times. Actions depend on ticking checkboxes first, and editing a group only
works when exactly all its members are ticked, an invisible rule. The New deployment drawer asks
for Type, Kind, Components and Engine, four words for overlapping ideas, with half the fields
marked "locked". Everything is named after a service (bee-uploader, feed owner, BEE_PUBLISHERS)
and nothing offers to fill a field from something the operator already runs.

## What the operator sees

- A left sidebar with three pages: **Overview**, **Deployments**, **Host**. A top bar with the
  page title, a search box on Deployments, a live indicator, and one primary button:
  **+ New deployment**. A light and a dark theme, following the system by default, switchable in
  the sidebar footer.
- **Overview**: host health (CPU, memory, disk, our stacks against everything else), deployment
  counts, a **Needs attention** list where every item carries the button that fixes it, the
  streams with their publish URL, and recent activity.
- **Deployments**: one list. Filter chips (All, Streams, Viewers, ABR, Groups, Needs attention),
  search, groups as collapsible blocks with their own actions, and per row: a status dot, the
  name, a plain-words type, a readiness pill, quick links, a Start or Stop button and a menu.
  Clicking a row opens its page. Nothing has to be selected first.
- **Deployment page**: header with name, type, status and actions. A **readiness checklist**
  (containers, funding, stamp, uploader, then the OBS URL) with each step carrying its action.
  Then cards: Publish, Watch, Storage and funding, Publishes to (ABR uploaders), Containers,
  Configuration, Remove. A side column with At a glance, Next steps and Notes.
- **Group page**: members table, Start all, Stop all, Add members, Edit shared settings, Remove
  group. For an ABR node pool: the rung table with funding and stamp per rung, and the pool
  string with "Create an ABR uploader using this pool".
- **Host**: three big bars, network and disk I/O, then the per-deployment container table.
- **New deployment**: a four-step dialog. 1 What to set up (Stream, Viewer, ABR node pool, ABR
  uploader, Custom). 2 Basics (name, host, group toggle, notes). 3 Settings, only the fields
  the choice needs. 4 Review, with "what happens next" in one sentence.
- **Edit**: a right drawer with only the editable fields. Fixed fields (type, components, host,
  name) are listed in a collapsed "fixed at creation" summary.

## Ground rules

- **No backend change.** Every action maps onto an endpoint in `manager/src/api/routes`.
- **No new runtime dependency.** React 18, MUI 6, viem and the `common` package are already
  there. Routing is a small hash router written here, not a new package.
- **MUI stays** as the component library. The look comes from a custom theme, not from
  replacing inputs, dialogs and menus.
- **Plain words first, technical names second.** Stream, Viewer, Bee node, ABR uploader,
  Custom. "A postage stamp is prepaid Swarm storage." Service names stay visible as small
  monospace chips. No em-dashes and no semicolons in any user-facing copy: use a comma, a
  full stop or a middle dot.
- **Every empty and error state says what to do next.**
- **Code style** follows the repository and the user's rules: comments only where the code
  cannot tell the story, names that read at the call site, shared shapes as named types,
  small single-purpose files (aim under 300 lines), repeated string literals as constants, no
  mutation of state objects, no `console.log`. Match the existing formatting (2 spaces, single
  quotes, trailing commas).
- **Secrets on screen.** A private key is never printed in full: show `••••••••` and the
  derived address. The SRT passphrase is already part of the publish URL, as today, so a Copy
  button on it is fine.
- **Dev data.** The mock manager below generates every key-shaped or batch-shaped value at
  startup with `crypto.randomBytes`. No hard-coded 64-hex constants anywhere in the repo.

## Routes

Hash routes, so the nginx and vite proxies for `/profiles`, `/groups`, `/metrics` and friends
are never in the way and no server config changes.

| hash | page |
|---|---|
| `#/` | Overview |
| `#/deployments` | Deployments list |
| `#/deployments/<name>` | Deployment page |
| `#/groups/<id>` | Group page |
| `#/host` | Host |

`useRoute()` parses `location.hash` and re-renders on `hashchange`. `navigate(route)` sets the
hash. Unknown hashes render the Overview.

## Vocabulary the code derives from a profile

Put these in `frontend/src/deployments/shape.ts` and `frontend/src/deployments/readiness.ts`.
They are frontend-only, so they live in the frontend, not in `common`.

**Services** of a profile: `defaultServicesFor(profile)` from `common`. The engine is `srs`
or `ome` inside that list.

**Shape** (the plain-words type), from the services, not from `kind`:

| shape | rule | label |
|---|---|---|
| `abr-uploader` | `kind === ABR_UPLOADER_KIND` | ABR uploader |
| `stream` | services include `stream-uploader` and an engine | Stream |
| `viewer` | services include `client` | Viewer |
| `bee-node` | `isBeeNodeOnly(profile)` | Bee node (a pool rung shows its rung too) |
| `custom` | anything else | Custom |

**Readiness** (`readinessOf(profile, health?)` returns `{ label, tone }`, tone is one of
`ok | warn | err | info | gray`). `health` is the optional `StampHealth` from the node, known
only on the deployment page.

1. `ERROR` → Failed, err. `DEPLOYING` → Deploying…, info. `STOPPING` → Stopping…, warn.
   `REMOVING` → Removing…, warn. `STOPPED` → Stopped, gray.
2. `RUNNING`, shape `stream` or a `custom` with `stream-uploader` and no pool:
   `pendingStamp` or no `stamp_id` → Needs a stamp, warn. Stamp set but no `stream-uploader`
   container (this is exactly `canDeployUploader`) → Uploader not started, warn. With health:
   dead → Stamp expired, err. pending → Stamp settling, info. expiring soon
   (`isStampExpiringSoon`) → Stamp ends soon, warn. Otherwise → Ready to stream, ok.
3. `RUNNING`, shape `abr-uploader`: `beePublishersProblem(bee_publishers)` → Pool string
   invalid, err. Otherwise → Ready to stream, ok.
4. `RUNNING`, shape `viewer` → Watchable, ok.
5. `RUNNING`, shape `bee-node`: no `stamp_id` → Needs a stamp, warn. With health dead →
   Stamp expired, err. pending → Stamp settling, info. Otherwise → Stamped, ok.
6. `RUNNING`, anything else → Running, ok.

**Needs attention** is any readiness whose tone is `warn` or `err`.

**Group readiness.** A pool (`isLadderKind(group.kind)`): the `GET /groups/:id/bee-publishers`
result `ready` → Pool ready, ok. Any member in a transitional status → Deploying…, info.
Otherwise `${stamped}/4 rungs stamped`, warn, where stamped counts rungs whose `stampState` is
not dead (same counting as today's `summariseRungs` in `LadderCard`). A standard group: all
members running → All running, ok. Any transitional → Changing…, info. Some running → Partly
running, warn. None → Stopped, gray.

**Pool problems**, one line per rung that holds the pool string back, from the
`bee-publishers` result's `missing` and `rungs` entries: "1080p: no stamp yet", "720p: node
is not running", "480p: stamp expired". Used on the Overview and the group page.

**URLs** stay in `urls.ts`: `srtPublishUrl(profile, serverHost, hostPassphrase)`,
`clientUrl(profile, serverHost)`, `componentUrl(host, port)`. Add `beeApiUrl(profile,
serverHost)` from the `bee-uploader` container's `API` port when there is one.

## The readiness checklist

On the deployment page. Steps are `{ title, state, detail, action? }`, state is one of
`ok | warn | err | busy | off`. Actions are ordinary buttons wired to the same handlers as the
header.

For a **stream** (and a custom with `stream-uploader` and its own node):

1. **Containers running.** ok when RUNNING (detail lists the services). busy while DEPLOYING.
   err on ERROR ("Last deploy failed, see the error above"). off when stopped, action Start
   (or Retry after an error).
2. **Bee node funded.** From `useBeeUtils(profile).wallet`. ok when both balances are above
   zero (compare with `BigInt`). warn when running and BZZ is zero ("Has xDAI but no BZZ. Send
   BZZ to the node address to be able to buy a stamp."). off when stopped. Action: Copy node
   address.
3. **Postage stamp set.** From `stampHealthFrom(profile.stamp_id, bee.stamps)`. none → warn
   when funded and running, else off, detail "A stamp is prepaid Swarm storage. Buy one below
   once the node has BZZ.", action Buy stamp (scrolls to the Storage card). expired or gone →
   err, action Buy stamp. pending → busy, "Bought, waiting for the network to confirm it. It is
   set automatically." active → ok with the time left, batch id and depth. Expiring soon →
   warn, action Buy next stamp.
4. **Uploader running.** ok when the `stream-uploader` container exists. warn when
   `canDeployUploader(profile)` and the stamp is active, action **Start uploader** (calls
   `deployUploader`). off otherwise, detail "Held back until a stamp is set. The rest of the
   stack runs meanwhile."

Result banner under the list: ok → "Ready. Point OBS or FFmpeg at this URL:" with the publish
URL and Copy. Otherwise "Not ready yet: <readiness label>." or "Stopped. Start it to get a
publish URL."

For an **ABR uploader**: Containers running, then **Node pool reachable** (ok when
`beePublishersProblem` is null, detail "4 rungs · <first url host> and 3 more", err with action
Edit otherwise). Banner as for a stream.

For a **viewer** (and any custom with `client`): Containers running, then **Following a
stream**: ok with the streamer's name when a profile on this manager has that `public_key`,
otherwise "External streamer 0x12ab…cd34", warn when no `feed_owner`. Banner: "Watchable. Open
the player:" with the client URL as a link.

For a **bee node** (a rung): Containers running, Bee node funded, Postage stamp set. Banner:
"This node is ready to receive uploads for its rung." or "Not ready: <label>."

Pool rungs pass `suggestedRungDepth(rung)` to the buy form, as `LadderCard` does today.

## Pages, card by card, with the API behind each

### Overview (`#/`)

- **Host card**: `useMetrics()` (the stream, mounted while the page is open, exactly as the
  Resources tab does today). CPU, Memory, Disk bars with two segments: our stacks (`infra`)
  and everything else (`host` minus `infra`), using `metricsMath.ts`. Before the first
  sample: "Waiting for the first sample…". "Details" goes to `#/host`.
- **Deployments card**: Running, Need attention, Stopped counts, and a line with counts per
  shape and group kind. "All" goes to `#/deployments`.
- **Needs attention**: every profile whose readiness tone is warn or err, plus every pool whose
  `bee-publishers` result is not ready (fetch once per pool, refetch on `profile.changed` for a
  member). Each row: dot, name, one sentence of what is wrong, the action that fixes it (Retry,
  Start uploader, Buy stamp which opens the page at the Storage card, Copy node address), and
  Open. Empty: "Everything is running and ready."
- **Streams**: streams and ABR uploaders with readiness, and Copy publish URL when ready.
- **Recent activity**: the last eight `profile.changed` and `profile.deleted` events seen in
  this session, as "name is running", "name stopped", "name failed to deploy", "name removed"
  with the time. Empty: "No changes since this page was opened."

### Deployments (`#/deployments`)

- Filter chips with counts: All, Streams (stream + abr-uploader), Viewers, ABR (bee-node rungs +
  abr-uploader), Groups, Needs attention. Search matches name and notes.
- Groups render first as blocks: a header row (chevron, name, "Group · 3 viewers" or "ABR node
  pool · 4 Bee nodes, one per quality", group readiness pill, "n/m running", Stop all / Start
  all / Open), then member rows indented. Collapsed state is local component state.
- Member and standalone rows: status dot (pulsing while transitional), name in monospace, a
  second line "Stream · slot 2 · lab-host-1" (a custom adds its services, a rung adds its
  rung), readiness pill, links (Copy publish URL only when readiness is ok, Watch link when
  the client URL exists and it is running), primary action (Stop when running, Start or Retry
  otherwise, a spinner label while transitional), and a `⋯` menu: Open, Edit, Create a viewer
  for this stream (streams that are running), Copy publish URL (when ready), Remove….
- The whole row is clickable and opens the page. Buttons and links inside stop propagation.
- Empty list: a card saying there is nothing yet with a New deployment button. Empty filter:
  "Nothing matches."
- A footer hint: "Click a row to open it. Every action is on the row itself, nothing needs to
  be selected first."

Actions call `deployProfile`, `stopProfile`, `deleteProfile`, `deployUploader` from `data.ts`.
Group Start all and Stop all fan out over the members with `Promise.allSettled`, one toast
summarising the result, as `runOnSelected` does today. Remove asks for confirmation first,
with the same text as today's dialog (it wipes the data directory).

### Deployment page (`#/deployments/<name>`)

Header: back link (with the group name when it belongs to one), name, shape pill, status pill,
meta line (host, slot, created date, service chips), actions: Start or Stop, Edit, `⋯` menu.

Main column:

- **Last error** card at the top when `last_error` is set, with the time and the message in a
  monospace block.
- **Readiness** card (above), with "n of m steps done" in the header.
- **Publish** card when `srtPublishUrl` is not null: the URL with Copy, a note about the
  passphrase source ("Encrypted with this deployment's own passphrase" or "with the host-wide
  passphrase", both already in the URL, or for OME "Its SRT listener takes no passphrase"),
  and a warning note when readiness is not ok: "Ingest is up, but nothing reaches Swarm until
  the checklist above is complete."
- **Watch** card when `clientUrl` is not null: the link with Copy and the streamer it follows.
- **Storage and funding** card for shapes `stream` and `bee-node`, `id="storage"`: reuse
  `NodeFunding`, `StampTable` (Use sets the stamp through `setStamp`) and `BuyStampForm`
  (`buyStamp`, then `waitForStamp`), all driven by one `useBeeUtils(profile)` that the page
  owns, so the checklist and the card agree. Refresh button. Alerts from today's `StampPanel`
  (dead stamp, expiring soon, waiting for a bought batch) move here.
- **Publishes to** card for `abr-uploader`: `PublisherRungList` with batch ids, or the "pool
  string is not usable" warning from today's `PoolUploaderCard`.
- **Containers** card: one row per container from `profile.containers`: service chip, what it
  does in plain words (a small `SERVICE_DESCRIPTIONS` map), ports as links, and CPU and memory
  when the metrics snapshot has a container with `project === profile.name` and the same
  service (mount `useMetrics()` on this page). For a stream without its uploader, add a muted
  row "stream-uploader · not started yet, waiting for a stamp". Stopped: "Start the deployment
  to see its containers."
- **Configuration** card: a definition list. Type, Components and Host marked "(fixed)". SRT
  passphrase ("own passphrase" with Copy, or "host-wide passphrase (default)"). Stream key
  (`••••••••` plus the address with Copy address). Bee node (own node with its API URL, or
  external with `bee_url`). Postage stamp (short id and state). Node pool (for abr-uploader).
  Follows streamer (for a client, with the name when it is on this manager). Edit button.
- **Remove** card with the danger button, same confirmation as the list.

Side column: **At a glance** (state pill, host, slot, engine, stamp time left, group link,
created), **Next steps** for a running stream ("Create a viewer for this stream", opens the
wizard prefilled), **Notes** with Edit.

### Group page (`#/groups/<id>`)

Header: back link, group name, "Group" or "ABR node pool" pill, group readiness pill, meta
("4 members · created … · one Bee node per quality rung, used as upload targets by an ABR
uploader"). Actions: Start all, Stop all, Edit shared settings, Remove group.

- **Pool string** card (pools only): when the `bee-publishers` result is ready, the value with
  Copy and a button "Create an ABR uploader using this pool" (opens the wizard prefilled) and
  the hint "For an uploader on another manager, paste the copied string into its form." When
  not ready: "Not ready yet. Every rung needs a running node with a usable stamp before this
  can be copied. Holding it up: 1080p: no stamp yet." Refresh button. Reload when any member's
  `stamp_id` changes, as `LadderCard` does today.
- **Members** card. Pools: one row per rung, ascending (`rungFromMemberName`, `rungOrder`):
  dot, rung with resolution and bitrate from `DEFAULT_ABR_LADDER` ("360p · 640×360 · 700 kbps
  · coordinator" for the first), member name and slot, readiness pill, funding (xDAI and BZZ
  from a per-row `useBeeUtils`, the BZZ in warning colour when zero), stamp (time left or
  state, from the `bee-publishers` result's per-rung `stampState`, falling back to "set" or
  "none" from `stamp_id`), actions (Buy stamp when running with no stamp, opening the page at
  Storage, else the primary action) and the menu. Standard groups: the same rows as the list.
  Header form "Add members" (count input, `addGroupMembers`) for standard groups only.
- **Shared settings** card (standard groups): type, host, follows streamer (viewers), SRT
  passphrase source (streams), notes, with Edit. Hint: "New members inherit these. Keys and
  stamps are never bulk-applied."
- **How a pool works** card (pools): the three sentences from the mockup.

Remove group: confirm, then `deleteProfile` for every member. The manager removes the group
row itself once its last member is gone (`syncMembershipAfterRemoval`).

### Host (`#/host`)

`useMetrics()`. Three cards with a big number, a sub line and a two-segment bar: CPU (`x% ·
n of 8 cores in use`, our stacks and everything else), Memory, Disk (used against total, with
"per-deployment data size is in the table"). Two small cards: Network now and Disk I/O now,
host against ours. A legend line. Then the existing `ContainerTable` (with `GroupBlock`,
`ContainerRow`, lazy disk size), titled "Per deployment". Before the first sample, the same
waiting state the Resources tab shows today.

## New deployment wizard

A MUI `Dialog` (maxWidth `md`) with a step rail on the left (What to set up, Basics, Settings,
Review) and Back / Continue / Deploy in the footer. Continue is disabled while the current step
has a validation error, and the error is written next to it in plain words. Escape and the
backdrop close it. Opening it with a prefill (`{ goal: 'viewer', feedStreamer: 'main-stage' }`
or `{ goal: 'abr-uploader', poolId: 2 }`) starts at step 2 with the name suggested
(`<stream>-viewer`, `<pool>-uploader`).

**Step 1, goals** as cards: Stream to Swarm (`srs`, `stream-uploader`, `bee-uploader`), Watch a
stream (`client`, `bee-gateway`), ABR node pool (`bee-uploader ×4`), ABR uploader (`srs`,
`stream-uploader`), Custom. One or two sentences each, as in the mockup.

**Step 2, basics.** Name (monospace, live preview: "Creates abr-pool-2-360p, …" for a pool,
"Creates loadtest-profile-1 … -3" for a group, the rule otherwise). Host: This machine
(default, sends `localhost`) or Another host over SSH with a text field. "Deploy several at
once as a group" toggle with a count, for Stream, Viewer and Custom only (a stream group warns
that members share one stream key). Notes.

**Step 3, settings**, per goal:

- **Stream**: Media engine (SRS default, OvenMediaEngine). SRT passphrase, SRS only: use the
  host-wide passphrase (the hint says whether the host has one, from `GET /config`), generate
  one for this deployment (shown, with Regenerate, `generateSrtPassphrase()`), type my own
  (validated with `SRT_PASSPHRASE_RE`). Stream key: generate a new key (`generatePrivateKey()`
  from viem, address shown, Regenerate) or use an existing key. Postage stamp: buy it after
  deploying (default) or paste an ID. Bee node: run its own (default) or use an external Bee
  API (`beeUrlProblem` validation). The external option is hidden in group mode, because
  `POST /groups` has no `bee_url`.
- **Viewer**: Stream to follow: a stream on this manager (a select over profiles with a
  `public_key`, the address is filled from it) or paste an address (`0x` + 40 hex).
- **ABR node pool**: nothing to decide. Show the four members with resolution, bitrate and
  suggested depth, and the note about funding each rung afterwards.
- **ABR uploader**: Node pool to publish to: a pool on this manager (select over ladder groups,
  disabled with "not ready yet" when its `bee-publishers` result is not ready, the value is the
  result's `value`) or paste the string from another manager (`beePublishersProblem`). Then
  SRT passphrase and Stream key as for a stream (the key is required here, as today).
- **Custom**: component checkboxes with plain-words descriptions (choosing `srs` unticks `ome`
  and the other way round), then the fields the chosen components need: passphrase for `srs`,
  stream key (and stamp, and external Bee API when there is no `bee-uploader`) for
  `stream-uploader`, stream to follow for `client` (required, as today).

**Step 4, review**: a definition list of everything chosen, then a green note "What happens
next." with one sentence per goal (from the mockup). The button reads Deploy, Deploy group (n)
or Create pool (4 nodes).

**Payloads.** Validation regexes move to `frontend/src/forms/validation.ts` (name, host,
address, private key, stamp id) and are shared with the drawers.

| goal | call |
|---|---|
| Stream, single | `createProfile({ name, kind: 'streamer', host, notes, components, private_key, public_key, stamp_id?, srt_passphrase?, bee_url? })`. `components` is the default list with `ome` swapped in for `srs` when chosen, and without `bee-uploader` when an external node is chosen (then `bee_url` is set). `public_key` is `privateKeyToAccount(key).address`. Host passphrase means the field is omitted. |
| Stream, group | `createDeploymentGroup({ group_name, size, kind: 'streamer', host, notes, components, private_key, public_key, stamp_id?, srt_passphrase? })` |
| Viewer, single | `createProfile({ name, kind: 'viewer', host, notes, feed_owner })` |
| Viewer, group | `createDeploymentGroup({ group_name, size, kind: 'viewer', host, notes, feed_owner })` |
| ABR node pool | `createDeploymentGroup({ group_name, size: ABR_LADDER_SIZE, abr_ladder: true, kind: 'custom', host, notes })` |
| ABR uploader | `createProfile({ name, kind: 'abr-uploader', host, notes, bee_publishers, private_key, public_key, srt_passphrase? })` |
| Custom, single | `createProfile({ name, kind: 'custom', host, notes, components, ...the fields its components need })` |
| Custom, group | `createDeploymentGroup({ ... same, without bee_url })` |

After a successful call: merge the returned profiles into the store, reload groups, close, toast
"Deploying <name>…", and navigate to the new deployment's page, or the group's page for a group
or pool. Errors from the API show inside the dialog through `getErrorMessage`.

## Edit drawers

**Deployment**: MUI `Drawer` on the right, 480px. A collapsed "Fixed at creation: type,
components, host, name" summary at the top. Fields by shape: SRT passphrase (radio: use the
host-wide passphrase, or own passphrase with a text field and Generate) when the services
include `srs`. Stream key (with Regenerate and the warning that viewers following the old
address stop seeing it) when the services include `stream-uploader`, ABR uploaders included.
Postage stamp ID (optional, for streams).
External Bee API when there is no `bee-uploader`. Node pool string for an ABR uploader (with a
live "4 rungs recognised" hint). Streamer to follow for a client, with the streams on this
manager offered as one-click fills. Notes. Footer: Cancel, Save and redeploy.

`PUT /profiles/:name` replaces every editable field and redeploys. **Build the body from the
profile's current values and overlay the edits**, so a field the drawer does not show keeps
its value (a rung's `stamp_id` must survive an edit of its notes). Use `updateProfile(name,
body)` with `UpdateProfileBody`. Host passphrase means `srt_passphrase: undefined`, which the
PUT stores as null. A changed key sends the new `public_key` as well.

**Group**: same drawer for a group. Fields: SRT passphrase (when the members run `srs`),
Streamer to follow (when they run `client`), Notes. A note at the top: "Changes apply to all n
members and redeploy them. Keys and stamps stay per member." Calls
`updateGroupConfig(id, { notes, feed_owner?, srt_passphrase })` where **choosing the host
passphrase sends `srt_passphrase: null`**. This is the fix for the finding in the PR #38
review: the PATCH treats `undefined` as "keep" and the old drawer sent `undefined`, so a group
could never go back to the host passphrase. Change `UpdateGroupConfigBody.srt_passphrase` to
`string | null` in `data.ts`. The yup schema (`string().notRequired()`) already accepts null.

## Shared pieces

- `frontend/src/app/theme.ts`: `createTheme({ cssVariables: { colorSchemeSelector: 'data' },
  colorSchemes: { light: { palette }, dark: { palette } }, shape: { borderRadius: 10 },
  typography, components })`. Mode switching with `useColorScheme()` from
  `@mui/material/styles` (System, Light, Dark, default system, MUI persists the choice).
  Palette from the mockup. Light: background default `#f4f5f7`, paper `#ffffff`, primary
  `#3b5bfd`, success `#158f52`, warning `#b56e00`, error `#cf3238`, info `#2a7fd4`, text
  primary `#14171d`, secondary `#4b5563`, divider `#e2e5ea`. Dark: background `#0e1014`,
  paper `#161920`, primary `#6f88ff`, success `#3bd27f`, warning `#f2b43c`, error `#ff6b6f`,
  info `#63a9ff`, text primary `#e9ebf1`, secondary `#aab1c0`, divider `#252a35`. Component
  defaults: Paper outlined, Button `textTransform: none`, Chip radius 99, dense tables,
  14px base font with the system font stack.
- `frontend/src/app/router.ts`: `useRoute`, `navigate`, `routes` helpers.
- `frontend/src/app/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`. Permanent sidebar from the
  `md` breakpoint, a temporary drawer with a menu button below it.
- `frontend/src/app/useDeploymentsStore.ts`: profiles, groups, server config (host and
  host passphrase), `load()`, the `/events` EventSource with its `connected` flag (the live
  indicator) and the activity log. Exposed through a context and a `useDeployments()` hook.
  This is today's `App.tsx` state, moved.
- `frontend/src/app/useDeploymentActions.ts`: start, stop, remove, deployUploader, group
  fan-outs, a `busy` set of names, toasts.
- `frontend/src/app/ToastProvider.tsx`: `useToast()` with a Snackbar and Alert queue.
- `frontend/src/components/`: `StatusDot`, `ReadinessPill`, `ShapePill`, `ServiceChip`,
  `CopyBox` (value plus Copy), `ConfirmDialog`, `RowMenu`, `EmptyState`, `SegmentedBar`
  (wraps today's `UsageBar` with the two-segment convention), `KeyValueList`.
- `SERVICE_DESCRIPTIONS`: `srs` "media server (SRT ingest)", `ome` "media server
  (OvenMediaEngine)", `stream-uploader` "uploads segments to Swarm", `bee-uploader` "own Bee
  node", `client` "web player", `bee-gateway` "Swarm gateway for the player".

## Mock manager for development and review

`frontend/dev/mock-manager.mjs`, plain Node 22, no dependencies, started with
`pnpm -C frontend dev:mock` on port 9876 (the vite proxy's default target). It implements
every endpoint the frontend calls, with the response shapes in `frontend/src/types` and
`common`:

`GET /config`, `GET /health`, `GET /profiles`, `POST /profiles`, `PUT /profiles/:name`,
`DELETE /profiles/:name`, `POST /profiles/:name/{deploy,stop,deploy-uploader}`,
`GET /profiles/:name/stamp/{address,wallet,stamps,chainstate}`,
`POST /profiles/:name/stamp/{buy,set}`, `GET /groups`, `POST /groups`,
`GET /groups/:id/bee-publishers`, `PATCH /groups/:id/config`, `POST /groups/:id/members`,
`GET /events` (SSE `profile.changed` and `profile.deleted`), `GET /metrics`,
`GET /metrics/stream` (SSE `snapshot` every two seconds), `GET /metrics/disk/:project`.

Behaviour: deploy moves a profile to DEPLOYING and to RUNNING after 1.5 s with a container
snapshot (ports from the slot, as the mockup does), stop to STOPPING then STOPPED, delete to
REMOVING then gone (and the group row when it was the last member). A bought stamp is
`usable: false` for 4 s, then usable. `deploy-uploader` adds the `stream-uploader` container
and clears `pendingStamp`. `bee-publishers` assembles the string from the rungs' stamps and
lists what is missing, in the `BeePublishersResult` shape. Seed data is the mockup's dataset:
`main-stage` (ready), `backup-stage` (needs a stamp, has BZZ), `viewer-eu`, `abr-gcp`
(pool-backed), `edge-test` (ERROR with a port message), `old-demo` (stopped, expired stamp),
group `loadtest` with three viewers, pool `abr-pool-1` with three stamped rungs and `1080p`
unstamped with no BZZ. Every address, key and batch id is random at startup.

## File plan

Create: `app/{theme.ts,router.ts,AppShell.tsx,Sidebar.tsx,TopBar.tsx,useDeploymentsStore.ts,
useDeploymentActions.ts,ToastProvider.tsx}`, `components/*` as listed,
`deployments/{shape.ts,readiness.ts,checklist.ts,DeploymentsPage.tsx,DeploymentRow.tsx,
GroupBlockRows.tsx,DeploymentPage.tsx,ReadinessCard.tsx,PublishCard.tsx,WatchCard.tsx,
StorageCard.tsx,PoolTargetCard.tsx,ContainersCard.tsx,ConfigurationCard.tsx,
AtAGlanceCard.tsx}`, `groups/{GroupPage.tsx,PoolStringCard.tsx,PoolRungRow.tsx,
useBeePublishers.ts,groupReadiness.ts}`, `overview/{OverviewPage.tsx,HostCard.tsx,
AttentionList.tsx,ActivityCard.tsx}`, `resources/{HostPage.tsx,HostBars.tsx}`,
`forms/{validation.ts,wizard/NewDeploymentWizard.tsx,wizard/steps/*.tsx,wizard/wizardState.ts,
wizard/wizardSubmit.ts,EditDeploymentDrawer.tsx,EditGroupDrawer.tsx,PassphraseField.tsx,
StreamKeyField.tsx}`, `dev/mock-manager.mjs`.

Delete once nothing imports them: `App.tsx` is rewritten to mount the shell,
`NewDeploymentDrawer.tsx`, `AbrPoolForm.tsx`, `AbrUploaderForm.tsx`, `DeploymentsTable.tsx`,
`DeploymentsTableGroupRow.tsx`, `DeploymentsTableRow.tsx`, `ResourcesView.tsx`,
`StatusChip.tsx`, `helperText.ts`, `uploaders/{UploadersView,LadderCard,UploaderCard,
PoolUploaderCard,UploaderShell,StreamPublishUrl,StampPanel}.tsx`,
`resources/{HostSection,OutsideSection,InfraSummary,ResourceMonitor}.tsx`.

Keep: `data.ts` (add the `null` on the group passphrase, `fetchBeePublishers` stays),
`http.ts`, `format.ts`, `urls.ts`, `useMetrics.ts`, `Sparkline.tsx`, `CopyButton.tsx`,
`ServerHostContext.ts`, `types/*`, `PublisherRungs.tsx`, `uploaders/{stampApi.ts,
useBeeUtils.ts,StampTable.tsx,BuyStampForm.tsx,NodeFunding.tsx}`,
`resources/{ContainerRow,ContainerTable,GroupBlock,StatCard,UsageBar}.tsx`,
`resources/{grouping,metricsMath}.ts`. `index.html` title becomes "Streaming Infra Manager".
`package.json` gains `"dev:mock": "node dev/mock-manager.mjs"`.

## Done means

- `pnpm -r typecheck`, `pnpm -r build` and `pnpm test` pass (the manager's unit tests need
  `DATABASE_URL` set to any value at import time).
- `pnpm -C frontend dev:mock` in one terminal and `pnpm -C frontend dev` in another render all
  five pages with the seed data and no console errors, and these flows work end to end against
  the mock: buy a stamp on `backup-stage` and start its uploader until it reads Ready to
  stream, create a stream and a viewer through the wizard, create a viewer from a stream's
  page, edit a group back to the host passphrase, add members to `loadtest`, remove
  `edge-test` after confirming, switch the theme.
- No file listed under Delete remains, no unused export remains, and no user-facing string
  contains an em-dash or a semicolon.

## Work split

Part A: everything except the wizard and the edit drawers. The TopBar's New deployment button,
the row menu's Edit and Create a viewer entries, the page's Edit buttons and the pool's Create
an ABR uploader button take callbacks the shell provides, stubbed with a toast "coming in Part
B" until Part B lands. Part A also delivers the mock manager and the theme.

Part B: the wizard, the two drawers, `forms/validation.ts`, the prefill flows, and wiring them
into the callbacks Part A left. Part B removes the "coming in Part B" stubs.
