# ABR Ladder

A deployment **group** whose members are one `bee-uploader` per ABR quality rung,
used as the publish targets for a `stream-uploader` running elsewhere (GCP).

## Motivation

[PR #174](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/174) gives the
uploader a `BeePublisherPool`: one funded Bee node per ladder rung, configured as

```
BEE_PUBLISHERS=360p@http://host:10015<batchid> 480p@http://host:10025<batchid> 720p@http://host:10035<batchid> 1080p@http://host:10045<batchid>
```

Postage batches drain in proportion to bitrate — across the shipped ladder 1080p
burns roughly 7× the bytes of 360p, so equal-depth batches expire hours apart.
One node per rung turns "a batch ran out, the stage stopped" into "one rung went
quiet and ABR stepped down". Each node also brings its own chequebook and its own
crash domain.

## The shape: a ladder is just a group

**A rung is an ordinary profile.** Its own port slot, its own data dir, its own
wallet, its own `stamp_id`, deployed by the `bee-uploader` service that already
exists. Nothing about a ladder is a new kind of deployment.

That is the whole design, and it buys two things:

- **`swarm-hls-stream` needs no changes at all.** Not one line. The streaming repo
  stays a general-purpose upstream that knows nothing about ladders. An earlier
  attempt taught it about "publisher pools" — a dedicated compose file, a second
  port map, per-service deploy gating — and that coupling is what this replaces.
- **Every per-node operation already works.** Fund, buy a batch, stop, remove,
  health, metrics — a rung is a profile, so the existing screens and endpoints
  apply unchanged. There is no ladder-specific funding UI, because there does not
  need to be one.

The ladder exists in exactly three places: `deployment_groups.kind`, which records
that the group is one; the member **names**, which record which rung is which; and
the `BEE_PUBLISHERS` string assembled from them.

## Rung identity lives in the name

Members are named `<group>-<rung>`: `abr1-360p`, `abr1-480p`, `abr1-720p`,
`abr1-1080p`.

Not in a column, and deliberately **not in the member's position**. Position is
not stable — remove one member and re-add it and every rung below it silently
re-maps, so a batch sized for 360p ends up paying for 1080p, and nothing about
the symptom points at the cause. A name is stable, unique, already validated by
the profile-name constraint, and legible in the deployments table.

Parsing always strips the *known* group name, so `abr` / `abr-1080p` and
`abr-1` / `abr-1-360p` cannot be confused for one another.

The one cost: profile names cap at 31 characters and a ladder appends `-1080p`,
so a ladder's group name is capped at **25**. Enforced in `createGroupSchema`
rather than discovered as a check-constraint violation with two members already
inserted.

Rung 1 (`360p`) is the lowest and is the **coordinator**:
`BeePublisherPool.coordinator()` returns `ordered[0]`, because it has the
longest-lived batch and carries the stream catalog and master playlist — the only
two addresses a viewer needs to open a stage.

## What is stored

| what | where it lives |
|---|---|
| that this group is a ladder | `deployment_groups.kind = 'abr-node-pool'` — one new column |
| that these four profiles are one unit | `deployment_groups` + `profiles.group_id` (already existed) |
| which rung a member publishes | its name |
| the batch it pays with | `profiles.stamp_id` (already existed, already managed) |
| its bee API port | derived from `port_slot`, as it always was |

One migration, adding one column. No new table, and no second port-slot family —
one port map, the original one.

### Why the kind is a column and not derived

Ladder-ness was briefly inferred by parsing member names for a rung suffix. That
works while the ladder is intact and fails precisely when it is not: remove one
rung and the group stops *looking* like a ladder, so the Uploaders tab stops
offering the ladder view — at the moment the operator most needs it to say
"1080p is missing".

Intent is a fact about the group and belongs in a column: `isLadderKind(group.kind)`
answers "is this a pool", for a damaged one too. Completeness is a different
question, and the only caller that needs it — `beePublishersForGroup` — answers
it per rung, naming the ones that are missing rather than returning a bare
false. Two helpers that derived pool-ness from the member names were dropped
once the column landed; using that derivation for identity is the bug the column
removes.

## Using it

1. **New deployment → Deployment type → ABR Node Pool.** Four profiles are
   created: `<pool>-360p` … `<pool>-1080p`, each with the single `bee-uploader`
   component.
2. **Deploy each rung.** Group creation inserts members as `STOPPED`; the
   orchestrator is not invoked (see [Known gaps](#known-gaps)).
3. **Uploaders tab.** The ladder card lists its four rungs, each expandable —
   fund its address with xDAI and xBZZ, then buy its batch. The buy form starts
   at that rung's suggested depth (**17 / 18 / 19 / 20** across the shipped
   ladder), because a rung's batch fills in proportion to its bitrate and a flat
   depth would put the four expiries hours apart.
4. **Copy `BEE_PUBLISHERS`** from the pool card once all four rungs report a
   *live* batch. The card only offers the value when each rung's own node
   confirms its batch; see [Rung validity](#rung-validity).
5. **Paste it into an ABR Uploader.** New deployment → Deployment type → **ABR
   Uploader**. See [The ABR Uploader](#the-abr-uploader).

## The ABR Uploader

The pool and the uploader normally sit on different machines under **different
managers** — the Bee nodes on bare metal where bandwidth is cheap, SRS and the
`stream-uploader` in GCP — so the uploader's manager cannot look the pool up: it
is a group in another database. What crosses between them is the string itself,
copied from one manager's pool card into the other's form.

`abr-uploader` is its own **profile kind** and its own **deployment type**, with
its own self-contained form, for the same reason the pool has one: it shares
almost nothing with a single-node deployment.

| | single-node uploader | ABR Uploader |
| --- | --- | --- |
| services | `srs` + `stream-uploader` + `bee-uploader` | `srs` + `stream-uploader` |
| where uploads go | its own Bee node, or `BEE_URL` | the pool's four rungs |
| postage | its own `stamp_id` | the pool's, one batch per rung |
| Uploaders tab | fund it, buy batches | no actions, just shows publish URL with pool targets |

It runs **no Bee node**: the pool's rungs are the publish targets, so there is no
wallet to fund, no batch to buy and no stamp to wait for. `managesOwnStamp` is
false, so it does not appear on the Uploaders tab at all — a funding panel there
would point at a node that does not exist. `isPendingStamp` is false, so
**Deploy uploader** is enabled from the start.

`BEE_PUBLISHERS` is required — without it the deployment would come up and never
upload anything — and validated where the operator can still fix it (form, API,
and again at deploy) with the uploader's own rules (`beePublishersProblem`):
every rung of the shipped ladder, none twice, nothing else, and an http(s)
address that is neither loopback nor an ssh target. The form shows the rungs a
valid paste resolves to, because a line of four URLs and four 64-character batch
ids is not something anyone proof-reads.

At deploy `writeProfileEnv` writes `BEE_PUBLISHERS`, `ABR_ENABLED=true` and
`ABR_LADDER` (emitted from `DEFAULT_ABR_LADDER`) into `.env.<profile>`. The root
env wins over `engines/srs/.env.<profile>` in `deploy.sh`, and both `srs` and the
uploader read all three from the compose environment — so the ladder the engine
encodes and the ladder the uploader publishes come from one definition and cannot
drift. SRS only; the ladder is not implemented for OME.

The string goes stale two ways, and since nothing links the two managers,
nothing invalidates a copy that has gone wrong:

- **A rung buys a *new* batch** (topping up keeps the id). Re-paste after a
  re-buy, until a stamp manager keeps batches from expiring.
- **A rung is removed and re-created**, which changes its *address*, not just
  its batch. Ports come from the profile's port slot, and a freed slot is
  reused by the next profile created on that machine — so `720p@…:10035` can
  come to mean an unrelated Bee node. The uploader keeps publishing that rung
  to it with a batch id it does not own, every upload is rejected, and the
  other three rungs carry on: a partial ABR degradation with nothing in either
  manager pointing at the cause. Re-paste after rebuilding a rung.

## BEE_URL: a single-node uploader on an external node

The other half of the same flexibility. A single-node deployment can name the
Bee API it publishes to instead of running its own — `profiles.bee_url`, the
**Bee API URL** field on the Streaming Infra form.

It applies **only to a deployment that runs no `bee-uploader`**, and that is not
a policy choice: `resolve_bee_url` in `deploy.sh` computes `BEE_URL` and writes it
into an override file that outranks `.env.<profile>` whenever a local
bee-uploader is enabled, and prints nothing when it is not. So with a local node
the field could never take effect. Rather than store a value that silently never
applies, the field is disabled while `bee-uploader` is checked (drop it — use
`custom` — to point at an external node), and the API rejects the combination.
It is also refused alongside `bee_publishers`, so a config cannot say two
different things about where uploads go.

**Requires `swarm-hls-stream` 46eb21a or later**, which this repo's submodule
pin carries. `resolve_bee_url` there decided "is there a local Bee node" from
`config.json` rather than from the services the invocation was asked to deploy
— and `config.json` is written once at bootstrap, never per profile — so it
overrode `BEE_URL` for *every* profile running a stream-uploader. An external
node named here was replaced by `http://bee-uploader:<port>`, a compose service
that is not running, and the container crash-looped on `ENOTFOUND` while the
manager reported `RUNNING`. Two changes there are what make a pool-backed uploader deployable
at all: the uploader service's `environment:` block in
`deploy/docker-compose.yml` now passes `BEE_PUBLISHERS` through (before, the
uploader read the variable but it never reached the container), and
`check_stamp` in `deploy.sh` no longer prompts for an empty `STAMP` when
`BEE_PUBLISHERS` is set — that prompt aborted the deploy under the manager's
stdin-less runner.

## Implementation

### `common`

| File | Change |
|---|---|
| `src/abrLadder.ts` (new) | The whole ladder domain: `DEFAULT_ABR_LADDER` (rungs, geometry, kbps), `ladderMemberName` / `rungFromMemberName` / `ladderMemberNames`, `rungOrder`, `suggestedRungDepth`, `assembleBeePublishers`, `beePublishersValue`, `parseBeePublishers` / `beePublishersProblem`, `abrLadderEnvValue`, `LADDER_GROUP_NAME_MAX`. |
| `src/abrLadder.test.ts` (new) | 55 tests over naming, round-tripping, group recognition, depth scaling and assembly — including that the name cap is exactly where member names stop fitting, and that a ladder of expired batches yields no value. |
| `src/stampHealth.ts` (new) | `stampHealthFrom` / `isStampExpired` / `isStampExpiringSoon` / `isDeadStampState` / `stampStateReason` / `sameBatchId` — the one place that decides what a recorded batch is worth. See [Rung validity](#rung-validity). |
| `src/publishUrl.ts` (new) | `classifyPublishUrl` / `isInvalidUrlState` / `publishUrlReason` / `publishUrlWarning` — what a rung's published address is worth, structurally, before anything is probed. |
| `src/publishUrl.test.ts` (new) | 9 tests: loopback in every spelling, ssh user info, non-http schemes, and that a bare internal hostname is *not* refused. |
| `src/stampHealth.test.ts` (new) | 18 tests over the classification and the expiry window, including that an unreachable node classifies as `unknown` and never as `expired`, and that a negative `batchTTL` is not expiry. |
| `src/stampGating.ts` | `isBeeNodeOnly` and `managesOwnStamp`. A rung has no `stream-uploader`, so the old gate said it needed no stamp — which would have left it invisible on the Uploaders tab with no way to fund it. |

### Manager

| File | Change |
|---|---|
| `src/schemas/profile.ts` | `abr_ladder` flag; group-name length rule that applies only to ladders. |
| `src/domain/ProfileService.ts` | Ladder member seeding (names fixed, components fixed to `bee-uploader`); `ladderMembersOf`; `beePublishersForGroup`; guards on `updateGroupConfig` and `addGroupMembers`. |
| `src/domain/StampService.ts` | `stampHealthFor` — what a rung's own node says about its recorded batch (state *and* TTL, so expiry can be warned about early), on a short timeout, never throwing; a 404 is an answer (`gone`), anything else is `unknown`. `publishUrlStateFor` — whether anything answers at the *published* address. `networkHostOf` — strips ssh user info out of a deploy target. Plus `beePublicApiUrlFor` — the URL an off-host uploader can reach, as opposed to `beeApiUrlFor`, which resolves a local profile to `host.docker.internal`. |
| `src/domain/errors/LadderGroupError.ts` (new) | 409 `ladder_group_invalid_operation`. |
| `src/api/routes/groups.ts` | `GET /groups/:id/bee-publishers`. |
| `test/unit/ladderSchema.test.ts` (new) | Pins the cross-field name rule, which uses yup's `this.parent` and would fail silently if the schema shape changed. |
| `test/unit/beePublishersReadiness.test.ts` (new) | 18 tests: the endpoint asks every rung, probes the exact address it publishes, refuses the value on a dead batch / stopped node / unusable address, and stays ready — with the value — for anything it merely could not confirm. |
| `test/unit/stampHealthFor.test.ts` (new) | 10 tests over the bee-answer mapping, above all that a timeout is `unknown` and not `expired`, and that the TTL survives. |
| `test/unit/beeApiUrl.test.ts` (new) | 7 tests on URL composition: the port band, ssh user info stripped from both URLs, no stray `@` left for the entry format, and an ssh alias deliberately left alone. |

`beePublishersForGroup` asks each rung's node whether its recorded batch is still
alive, all four in parallel on a 3s timeout. It first did not — every field came
from the profile rows, on the reasoning that live batch state already had a home
in the per-rung cards — and that is what produced the bug in
[Rung validity](#rung-validity). A node that cannot answer leaves its rung
*unverified* rather than unready, so an unreachable node still cannot fail the
request or block the value.

### Frontend

| File | Change |
|---|---|
| `src/uploaders/LadderCard.tsx` (new) | The assembled `BEE_PUBLISHERS` with a copy button (or exactly which rungs are holding it up), then each rung's own `UploaderCard` nested beneath, expandable one by one. `summariseRungs` counts the header chip from the *verified* state the manager reports, and `mostUrgent` picks the one problem chip — `N of 4 not running` / `N bad addresses` / `N batches expired` — in the same order readiness blocks in. The server's `warnings` render under the value. |
| `src/uploaders/UploaderCard.tsx` | Generalised with three optional props — `label`, `badges`, `defaultDepth` — plus `nested` for elevation. Standalone use is unchanged. The summary chip is now a `StampStateChip` driven by the node's answer (and showing `Expires in 6h` while a batch is nearly spent, since a collapsed row is where a ladder gets scanned), a status chip appears when the node is not running, a dead or nearly-dead batch raises an alert in the body, and **Deploy uploader** is disabled while the batch is dead. |
| `src/uploaders/BuyStampForm.tsx` | Optional `defaultDepth`, so a rung's form starts at *its* suggested depth rather than a flat 17. |
| `src/uploaders/UploadersView.tsx` | Ladder cards first (selected by `group.kind`, so a damaged ladder still appears), then every profile that manages its own stamp — which now includes bee-only rungs. |
| `src/uploaders/UploaderCard.tsx` | Also hides "Deploy uploader" and the SRT publish URL for a bee-only profile: it runs no uploader and no media engine, so it has nothing to ingest on. |
| `src/AbrPoolForm.tsx` (new) | The entire pool form, self-contained. |
| `src/NewDeploymentDrawer.tsx` | A top-level **Deployment type** combobox — *ABR Node Pool* / *Streaming Infra* — that swaps in `AbrPoolForm` wholesale. The old `ladderMode` boolean is gone. |
| `src/data.ts` | `fetchBeePublishers`, returning `null` for a group that is not a ladder so callers can probe cheaply. The response types are now re-exported from `common` rather than redeclared — the local copy had already gone stale, with the per-rung verification fields arriving in the JSON and invisible to the compiler. |
| `src/uploaders/useBeeUtils.ts` | `stamps` is nullable — null for "not asked / no answer" — like `address`, `wallet` and `chainState` beside it, and any failed fetch clears it. Without that distinction a slow or briefly unreachable node reads as a node with a dead batch. |
| `src/uploaders/StampTable.tsx` | An `expired` state in the Usable column (it previously read `pending`, i.e. as something that would come good on its own), `in use — expired` on the active row, and an empty table that names the orphaned id instead of saying "No stamps on this node yet." |

## Why the pool form is a separate component

The pool briefly lived as a checkbox inside the main drawer, and that produced a
form which lied about what it would create: **Kind**, **Components** and **Media
engine** kept rendering, so the drawer showed "viewer / client + bee-gateway"
while the server — which fixes a pool's components to `bee-uploader` — was going
to create four Bee nodes. The group-name hint promised `<group>-profile-1` names
that a pool never uses.

Every one of those was a missing `!ladderMode` guard. A pool shares almost
nothing with a streaming-infra deployment — no kind, no components, no engine, no
feed, no key, no stamp, fixed size — so expressing it as conditionals inside the
other form meant one guard per irrelevant field, and the failure mode of a missed
guard was a form that quietly contradicted reality.

`AbrPoolForm` has nothing to guard: the fields that do not apply are simply not
in the file. The drawer picks a form; each form owns its own state, validation
and submit.

## Rung validity

Three things have to be true before a rung can accept an upload, and the ladder
originally asserted all three from stored state rather than checking any of them:
its **node is running**, its **address is reachable**, and its **batch is alive**.
Readiness now checks each, in that order — the order the operator has to fix them
in, since a stopped node makes its batch moot and an unusable address makes both
moot.

### The batch

`profiles.stamp_id` records **which batch a rung was pointed at**, not that the
batch still works. A postage batch is a paid, finite lease: it runs out on its
own, bee stops accepting uploads against it, and once it has been spent long
enough bee drops it from `/stamps` altogether. Nothing writes any of that back to
the column.

Treating a set `stamp_id` as "this rung can upload" is therefore wrong, and it
failed exactly as you would expect: a ladder whose four batches had all expired a
week earlier still showed `4/4 rungs stamped` in green, still handed out a
paste-ready `BEE_PUBLISHERS`, and still offered **Deploy uploader** — while every
rung's stamp table sat empty and every upload failed.

So anything that claims a rung is ready asks its node. `stampHealthFrom`
(`common/src/stampHealth.ts`) classifies the answer into one state:

| State | Meaning | Blocks readiness |
|---|---|---|
| `none` | No batch recorded on the profile. | yes |
| `active` | On the node, usable, time left. | no |
| `pending` | On the node, bought too recently to be usable. | yes |
| `expired` | On the node, `batchTTL` is 0. | yes |
| `gone` | Recorded, but the node does not have it — expired and dropped, or never bought there. | yes |
| `unknown` | The node was not asked, or could not answer. | **no** |

`unknown` is the state that keeps the fix honest in both directions. A node being
unreachable is not evidence that its batch is dead, so it must not raise an alarm
— but it is not evidence the batch is *alive* either, so it must not read as
"set". It renders as an explicit *unverified*, on the rung and on the assembled
value.

`batchTTL` needs care: bee returns `0` for a spent batch but a **negative** value
when it cannot work the TTL out, which is not the same thing. Only `0` means
expired.

The frontend holds the same distinction in its own state: `useBeeUtils` exposes
`stamps` as `BeeStamp[] | null`, null meaning "not asked, or no answer", and a
failed fetch clears it rather than leaving the last answer standing. A list nobody
can currently confirm is not evidence — and a stale one shown under a "bee node
unreachable" banner contradicts it. Both halves of that were got wrong first time
(see PR #33 review): a `stampsLoaded` flag latched true, so a node that stopped
answering kept reading as verified, and the stamps table treated its initial empty
array as an answer, so it claimed a dropped batch before any request had been made.

The TTL is also carried back rather than discarded, so a batch can be reported
**before** it runs out: within `STAMP_EXPIRY_WARNING_SECONDS` (48h) the rung reads
`Expires in 6h` and the ladder warns without withholding the value. Expiry itself
was only ever discoverable after everything had already stopped.

### The address

The URL is composed arithmetically — `PUBLIC_HOST` plus `10005 + slot*10` — so it
always *looks* like an address whether or not anything is there. Two ways it goes
wrong are provable without touching the network, which matters because both are
otherwise silent:

- **A loopback host.** `resolveServerHost()` falls back to `localhost` when
  `PUBLIC_HOST` is unset and logs a warning nobody reads. The value assembles
  perfectly and works nowhere but the manager's own machine.
- **An ssh target used as a network address.** `profiles.host` holds a *deploy*
  target: the schema validates it against `[a-zA-Z0-9._@-]` and documents it as
  "localhost, an ssh alias, or user@host". `user@host` composed to
  `http://deploy@1.2.3.4:10055` — not a bee base URL, and a stray `@` inside an
  entry format that already separates the rung from the URL on `@`.

The second is now *fixed* rather than merely detected: `networkHostOf` strips the
userinfo when composing either URL, because the ssh account provably is not part
of the address. An ssh *alias* is left alone — it may well resolve for the
uploader, and refusing it would be a guess dressed as a verdict. The structural
check in `classifyPublishUrl` stays as the guard on a permissive field.

The third way — well-formed but nothing listening — needs a probe, and the probe
targets the **published** URL, not `beeApiUrlFor`. That is the whole point: the
manager reaches a local node through `host.docker.internal` or `127.0.0.1`, so
verifying a batch proves nothing about the address an uploader elsewhere is
handed. When those two disagree the ladder looks complete and no upload lands.

A failed probe of a public address **warns** rather than blocks: NAT hairpinning
explains it just as well as a wrong address does, and a manager that cannot loop
back through its own public address says nothing about an uploader on another
host.

### The node

`LadderRungState.status` was carried through the response and then ignored, and
the Uploaders tab — being about batches — showed no status at all, so a stopped
rung looked exactly like a running one. Only `RUNNING`
(`PUBLISHABLE_RUNG_STATUS`) is publishable; anything else blocks with the state it
is actually in, and the card grows a status chip *when it is not running*, since a
chip on every healthy row would bury the one row that needs attention.

### Blocking versus warning

| | Blocks the value | Warns, value still served |
|---|---|---|
| Node | not `RUNNING` | — |
| Address | `loopback`, `ssh-target`, `malformed` | `unreachable` |
| Batch | `none`, `pending`, `expired`, `gone` | `unknown`, expiring within 48h |

The right-hand column is the honest half. Every entry there is something we could
not confirm rather than something we found wrong, and treating "could not check"
as "broken" would trade one false claim for another. Warnings are reported only
for rungs not already blocked — one complaint per rung, and it is the actionable
one.

## Guards

Two group-level operations were written for plain fan-out groups and would
quietly corrupt a ladder. Both now refuse with a 409:

1. **`updateGroupConfig` bulk-applies `stamp_id` to every member.** On a ladder
   that hands all four rungs the same batch — precisely the failure a node per
   rung exists to prevent, since the batches are deliberately different sizes.
   Other shared fields stay bulk-editable.
2. **`addGroupMembers` names new members `<group>-profile-N`**, which is not a
   rung name, so the member would sit in the group without ever being part of the
   ladder.

Both guards key off `deployment_groups.kind` rather than the member names, so a
ladder that has already lost a rung still refuses them. Deriving ladder-ness from
names would have dropped both guards at exactly the wrong moment — letting
`addGroupMembers` append a `-profile-N` member to a ladder that was mid-repair.

## Known gaps

1. **Creating a ladder does not deploy it.** `createGroup` inserts members as
   `STOPPED` and never calls the orchestrator — existing group behaviour, not
   specific to ladders, and contrary to what `group-deployment.md` claims. You
   deploy each rung yourself. Arguably right here (fund and stamp before the
   uploader points at them), but it is four clicks.
2. **Nothing enforces ladder integrity after creation.** Any rung can be stopped
   or removed individually, leaving a 3-rung ladder. The ladder card reports
   which rung is missing; nothing prevents it.
3. **Ports are not dense.** Four slots at 10 ports each = 40 reserved to use 8.
   Deliberate: it is the price of a rung being an ordinary profile, and at 999
   slots it caps at ~250 ladders, which is not a practical limit.
4. **The Bee API is unauthenticated**, and the uploader must reach all four rung
   API ports. WireGuard is the intended path rather than public exposure.

## Future work

- An automatic stamp-manager layer: top up or re-buy a rung's batch before it
  expires, instead of the manual per-rung buy. Expiry is now *visible* rather
  than silent, but the repair is still four manual buys.
- Liveness on the Deployments tab. `pendingStamp` there is still derived from the
  column alone, because reporting it honestly would mean probing every profile's
  node on every list. The Uploaders tab is the one place that asks.
- Reachability *from the uploader* rather than from the manager. The probe can
  only tell you what the manager can reach, which is why an unreachable published
  address warns instead of blocking; a check run from where the uploader actually
  lives would be conclusive.
- A group-level deploy action, which would also fix gap 1 for ordinary groups.
- Failover in `BeePublisherPool`: losing the coordinator currently blocks new
  viewers from joining while existing ones play on.
