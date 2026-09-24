# ABR Ladder

Status, 2026-09-16: built and merged to `main-v2`, page checked against the code at ecaea40.
Corrected 2026-09-17 against the code at `0c0354c`: "The address", the D16 paragraphs under
"The ABR Uploader", and the "Manager" table. The first real pool on the live host had been
handed a public address no Bee node listens on. Corrected 2026-09-23 against the code at
`87673c99`: the Implementation tables no longer say how many tests each file holds. Five of the
seven counts had drifted from their suites, and each row's description says what its tests cover.

A deployment **group** whose members are one `bee-uploader` per ABR quality rung,
used as the publish targets for a `stream-uploader`. Since T15 that uploader is
normally one this same manager deploys beside the pool, on the same host, and
since 2026-09-17 the string it is handed names the pool at the address a
container on that host reaches. An uploader on another machine is the older
shape and still works with the string pasted across, see The address.

## Motivation

[PR #174](https://github.com/Solar-Punk-Ltd/swarm-hls-stream/pull/174) gives the
uploader a `BeePublisherPool`: one funded Bee node per ladder rung, configured as

```
BEE_PUBLISHERS=360p@http://host:10015<batchid> 480p@http://host:10025<batchid> 720p@http://host:10035<batchid> 1080p@http://host:10045<batchid>
```

Postage batches drain in proportion to bitrate. Across the shipped ladder 1080p
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
  attempt taught it about "publisher pools" (a dedicated compose file, a second
  port map, per-service deploy gating), and that coupling is what this replaces.
- **Every per-node operation already works.** Fund, buy a batch, stop, remove,
  health, metrics. A rung is a profile, so the existing screens and endpoints
  apply unchanged. There is no ladder-specific funding UI, because there does not
  need to be one.

The ladder exists in exactly three places: `deployment_groups.kind`, which records
that the group is one, the member **names**, which record which rung is which, and
the `BEE_PUBLISHERS` string assembled from them.

## Rung identity lives in the name

Members are named `<group>-<rung>`: `abr1-360p`, `abr1-480p`, `abr1-720p`,
`abr1-1080p`.

Not in a column, and deliberately **not in the member's position**. Position is
not stable. Remove one member and re-add it and every rung below it silently
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
longest-lived batch and carries the stream catalog and master playlist, the only
two addresses a viewer needs to open a stage.

## What is stored

| what | where it lives |
|---|---|
| that this group is a ladder | `deployment_groups.kind = 'abr-node-pool'`, one new column |
| that these four profiles are one unit | `deployment_groups` + `profiles.group_id` (already existed) |
| which rung a member publishes | its name |
| the batch it pays with | `profiles.stamp_id` (already existed, already managed) |
| its bee API port | derived from `port_slot`, as it always was |

One migration, adding one column. No new table, and no second port-slot family,
one port map, the original one.

### Why the kind is a column and not derived

Ladder-ness was briefly inferred by parsing member names for a rung suffix. That
works while the ladder is intact and fails precisely when it is not: remove one
rung and the group stops *looking* like a ladder, so the Uploaders tab stops
offering the ladder view, at the moment the operator most needs it to say
"1080p is missing".

Intent is a fact about the group and belongs in a column: `isLadderKind(group.kind)`
answers "is this a pool", for a damaged one too. Completeness is a different
question, and the only caller that needs it, `beePublishersForGroup`, answers
it per rung, naming the ones that are missing rather than returning a bare
false. Two helpers that derived pool-ness from the member names were dropped
once the column landed. Using that derivation for identity is the bug the column
removes.

## Using it

1. **New deployment → Deployment type → ABR Node Pool.** Four profiles are
   created: `<pool>-360p` … `<pool>-1080p`, each with the single `bee-uploader`
   component.
2. **The rungs deploy themselves.** Creating the pool reserves and deploys
   every member, so the four Bee nodes come up without another click. Fund
   and stamp them next.
3. **Uploaders tab.** The ladder card lists its four rungs, each expandable:
   fund its address with xDAI and xBZZ, then buy its batch. The buy form starts
   at that rung's suggested depth (**17 / 18 / 19 / 20** across the shipped
   ladder), because a rung's batch fills in proportion to its bitrate and a flat
   depth would put the four expiries hours apart.
4. **Copy `BEE_PUBLISHERS`** from the pool card once all four rungs report a
   *live* batch. The card only offers the value when each rung's own node
   confirms its batch. See [Rung validity](#rung-validity).
5. **Paste it into an ABR Uploader.** New deployment → Deployment type → **ABR
   Uploader**. See [The ABR Uploader](#the-abr-uploader).

## The ABR Uploader

What crosses between the pool and the uploader is the string itself. The
everyday case since T15 is one manager and one host: the wizard picks a local
pool and copies the string into the uploader, and since 2026-09-17 the string
carries the Docker bridge address a container on this host reaches the nodes on.
The shape this page was first written for, the Bee nodes on bare metal where
bandwidth is cheap and SRS with the `stream-uploader` on another machine under
**another manager**, is still possible: that manager cannot look the pool up,
since it is a group in another database, so the string is pasted from one
manager's pool card into the other's form. Then the address it carries has to
be one that machine can reach, which is `BEE_LOCAL_HOST` plus a bind that
admits it, as The address explains.

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
false, so it does not appear on the Uploaders tab at all, because a funding panel there
would point at a node that does not exist. `isPendingStamp` is false, so
**Deploy uploader** is enabled from the start.

`BEE_PUBLISHERS` is required, because without it the deployment would come up and
never upload anything, and it is validated where the operator can still fix it (form, API,
and again at deploy) with the uploader's own rules (`beePublishersProblem`):
every rung of the shipped ladder, none twice, nothing else, and an http(s)
address that is neither loopback nor an ssh target. The form shows the rungs a
valid paste resolves to, because a line of four URLs and four 64-character batch
ids is not something anyone proof-reads.

At deploy `writeProfileEnv` writes `BEE_PUBLISHERS`, `ABR_ENABLED=true` and
`ABR_LADDER` (emitted from `DEFAULT_ABR_LADDER`) into `.env.<profile>`. The root
env wins over `engines/srs/.env.<profile>` in `deploy.sh`, and both `srs` and the
uploader read all three from the compose environment, so the ladder the engine
encodes and the ladder the uploader publishes come from one definition and cannot
drift. SRS only, and the ladder is not implemented for OME.

The string goes stale two ways, and since nothing links the two managers,
nothing invalidates a copy that has gone wrong:

- **A rung buys a *new* batch** (topping up keeps the id). Re-paste after a
  re-buy, until a stamp manager keeps batches from expiring.
- **A rung is removed and re-created**, which changes its *address*, not just
  its batch. Ports come from the profile's port slot, and a freed slot is
  reused by the next profile created on that machine, so `720p@…:10035` can
  come to mean an unrelated Bee node. The uploader keeps publishing that rung
  to it with a batch id it does not own, every upload is rejected, and the
  other three rungs carry on: a partial ABR degradation with nothing in either
  manager pointing at the cause. Re-paste after rebuilding a rung.

**Since 2026-09-17 a rung that is not answering does not stop the uploader
starting** (decision D16, the owner: "we should be able to start the uploader but
maybe say its node not available, try to reconnect or something"). Both checks of
the manager's own start gate, the batch and the chequebook, log a node that says
nothing and let the start through, and on the owner's further ruling of the same
day the chequebook check never refuses at all: a dry chequebook is a warning and
the uploader starts. What still refuses is one thing only, a batch the node
itself reports as unknown, expired or not usable. The uploader then waits for its
node instead of exiting, and
reports that wait on its own `/health`. The deployment page reads that route
every ten seconds and the **Uploader running** step says which node is being
waited for, how many attempts it has made and since when, and clears when the
node answers. A startup gate that warned instead of refusing shows there too,
named in plain words: "the chequebook gate warned on the 360p rung".

The uploader half of this is in the pinned stack since 7b2312f, which pinned the
stack commit 55b22bf1 that carries it, and every pin since carries it too, the
stack's release `v3.3` as of 2026-09-24. So a deployment reports those
fields once the host runs that pin. A deployment still
on an older build reports none of them, the manager reads that as no waiting
state reported, and the step says what it always said, which is that the
container is running and nothing beyond that has been verified.

## BEE_URL: a single-node uploader on an external node

The other half of the same flexibility. A single-node deployment can name the
Bee API it publishes to instead of running its own. That is `profiles.bee_url`, the
**Bee API URL** field on the Streaming Infra form.

It applies **only to a deployment that runs no `bee-uploader`**, and that is not
a policy choice: `resolve_bee_url` in `deploy.sh` computes `BEE_URL` and writes it
into an override file that outranks `.env.<profile>` whenever a local
bee-uploader is enabled, and prints nothing when it is not. So with a local node
the field could never take effect. Rather than store a value that silently never
applies, the field is disabled while `bee-uploader` is checked (drop it and use
`custom` to point at an external node), and the API rejects the combination.
It is also refused alongside `bee_publishers`, so a config cannot say two
different things about where uploads go.

**Requires a `swarm-hls-stream` whose `resolve_bee_url` reads the service list
the invocation was asked to deploy**, which this repo's submodule pin carries and
has since 2026-09-04. (This paragraph named a commit that no longer resolves in
the submodule's history, so the requirement is stated by behaviour instead.)
`resolve_bee_url` previously decided "is there a local Bee node" from
`config.json` rather than from the services the invocation was asked to deploy
, and `config.json` is written once at bootstrap, never per profile, so it
overrode `BEE_URL` for *every* profile running a stream-uploader. An external
node named here was replaced by `http://bee-uploader:<port>`, a compose service
that is not running, and the container crash-looped on `ENOTFOUND` while the
manager reported `RUNNING`. Two changes there are what make a pool-backed uploader deployable
at all: the uploader service's `environment:` block in
`deploy/docker-compose.yml` now passes `BEE_PUBLISHERS` through (before, the
uploader read the variable but it never reached the container), and
`check_stamp` in `deploy.sh` no longer prompts for an empty `STAMP` when
`BEE_PUBLISHERS` is set. That prompt aborted the deploy under the manager's
stdin-less runner.

## Implementation

### `common`

| File | Change |
|---|---|
| `src/abrLadder.ts` (new) | The whole ladder domain: `DEFAULT_ABR_LADDER` (rungs, geometry, kbps), `ladderMemberName` / `rungFromMemberName` / `ladderMemberNames`, `rungOrder`, `suggestedRungDepth`, `assembleBeePublishers`, `beePublishersValue`, `parseBeePublishers` / `beePublishersProblem`, `abrLadderEnvValue`, `LADDER_GROUP_NAME_MAX`. |
| `src/abrLadder.test.ts` (new) | Tests over naming, round-tripping, group recognition, depth scaling and assembly, including that the name cap is exactly where member names stop fitting, and that a ladder of expired batches yields no value. |
| `src/stampHealth.ts` (new) | `stampHealthFrom` / `isStampExpired` / `isStampExpiringSoon` / `isDeadStampState` / `stampStateReason` / `sameBatchId`, the one place that decides what a recorded batch is worth. See [Rung validity](#rung-validity). |
| `src/publishUrl.ts` (new) | `classifyPublishUrl` / `isInvalidUrlState` / `publishUrlReason` / `publishUrlWarning`, what a rung's published address is worth, structurally, before anything is probed. |
| `src/publishUrl.test.ts` (new) | Tests for loopback in every spelling, ssh user info, non-http schemes, and that a bare internal hostname is *not* refused. |
| `src/stampHealth.test.ts` (new) | Tests over the classification and the expiry window, including that an unreachable node classifies as `unknown` and never as `expired`, and that a negative `batchTTL` is not expiry. |
| `src/stampGating.ts` | `isBeeNodeOnly` and `managesOwnStamp`. A rung has no `stream-uploader`, so the old gate said it needed no stamp, which would have left it invisible on the Uploaders tab with no way to fund it. |

### Manager

| File | Change |
|---|---|
| `src/schemas/profile.ts` | `abr_ladder` flag, and the group-name length rule that applies only to ladders. |
| `src/domain/ProfileService.ts` | Ladder member seeding (names fixed, components fixed to `bee-uploader`), `ladderMembersOf`, `beePublishersForGroup`, and guards on `updateGroupConfig` and `addGroupMembers`. |
| `src/domain/StampService.ts` | `stampHealthFor`, what a rung's own node says about its recorded batch (state *and* TTL, so expiry can be warned about early), on a short timeout, never throwing. A 404 is an answer (`gone`), anything else is `unknown`. `publishUrlStateFor` asks whether anything answers at the *published* address. `networkHostOf` turns a deploy target into an address, through `resolveNetworkHost`. Plus `beePublisherUrlFor`, the URL a pool string carries, which for a local member is the address a container on this host reaches it on (2026-09-17), as opposed to `beeApiUrlFor`, which is the manager’s own read of that node. |
| `src/utils/deployHost.ts` (new) | `resolveNetworkHost`: ssh user info dropped, a dotless alias resolved through `ssh -G` against the config the api container mounts, results cached for 60s. The same semantics as `host_from_target` in swarm-hls-stream's `deploy/scripts/_lib.sh`, so both halves of a deploy agree on what an alias means. |
| `src/domain/ContainerRepository.ts` | `withContainers` derives `network_host` onto every profile the API returns, so the UI composes links from an address rather than from a deploy target. |
| `src/domain/errors/LadderGroupError.ts` (new) | 409 `ladder_group_invalid_operation`. |
| `src/api/routes/groups.ts` | `GET /groups/:id/bee-publishers`. |
| `test/unit/ladderSchema.test.ts` (new) | Pins the cross-field name rule, which uses yup's `this.parent` and would fail silently if the schema shape changed. |
| `test/unit/beePublishersReadiness.test.ts` (new) | Tests that the endpoint asks every rung, probes the exact address it publishes, refuses the value on a dead batch / stopped node / unusable address, and stays ready, with the value, for anything it merely could not confirm. |
| `test/unit/stampHealthFor.test.ts` (new) | Tests over the bee-answer mapping, above all that a timeout is `unknown` and not `expired`, and that the TTL survives. |
| `test/unit/beeApiUrl.test.ts` (new) | Tests on URL composition: the port band, ssh user info stripped from both URLs, no stray `@` left for the entry format, and an unresolvable alias still composing to the address it names. |
| `test/unit/deployHost.test.ts` (new) | Tests on target resolution with `ssh -G` injected: an alias resolved, an unknown name echoed back and kept, ssh failing without throwing, literals and dotted names never reaching the exec, a non-name refused at the exec boundary, and the TTL cache. |

`beePublishersForGroup` asks each rung's node whether its recorded batch is still
alive, all four in parallel on a 3s timeout. It first did not. Every field came
from the profile rows, on the reasoning that live batch state already had a home
in the per-rung cards, and that is what produced the bug in
[Rung validity](#rung-validity). A node that cannot answer leaves its rung
*unverified* rather than unready, so an unreachable node still cannot fail the
request or block the value.

### Frontend

| File | Change |
|---|---|
| `src/groups/PoolStringCard.tsx` | What a pool exists to produce: the assembled `BEE_PUBLISHERS` with a copy button, or exactly which rung is in the way. The server's `warnings` render under the value. |
| `src/groups/PoolRungRow.tsx` | One rung's row, driven by the node's own answer about its batch. A status chip appears when the node is not running, and a dead or nearly spent batch raises an alert rather than a silent row. |
| `src/groups/GroupPage.tsx`, `GroupMembersCard.tsx` | The pool's own page: the string card above, then its rungs, each expandable to the funding and batch controls. A damaged ladder still appears, selected by `group.kind`. |
| `src/groups/groupReadiness.ts`, `useBeePublishers.ts` | What the page asks the manager and how it counts the header chip, from the *verified* state the manager reports rather than from the profile rows. |
| `src/uploaders/BuyStampForm.tsx` | Optional `defaultDepth`, so a rung's form starts at *its* suggested depth rather than a flat 17. |
| `src/uploaders/NodeFunding.tsx`, `StampTable.tsx` | A rung's wallet, address and batch list. The Usable column has an `expired` state, which previously read `pending`, that is, as something that would come good on its own, and an empty table names the orphaned id instead of saying "No stamps on this node yet." |
| `src/forms/wizard/` | **Deployment type** is a step of the wizard, and `PoolPrerequisites.tsx` and `PoolSettings.tsx` are the pool's own screens. `poolDraft.ts`, `poolIdentity.ts` and `poolMembership.ts` hold its draft, so a pool created mid-wizard is not lost by a step back. |
| `src/PublisherRungs.tsx` | Renders the rungs a pasted `BEE_PUBLISHERS` resolves to, because a line of four URLs and four 64-character batch ids is not something anyone proof-reads. |
| `src/deployments/PoolTargetCard.tsx` | On an ABR uploader's own page, where its four rungs land. |
| `src/data.ts` | `fetchBeePublishers`, returning `null` for a group that is not a ladder so callers can probe cheaply. The response types are re-exported from `common` rather than redeclared. The local copy had already gone stale, with the per-rung verification fields arriving in the JSON and invisible to the compiler. |
| `src/uploaders/useBeeUtils.ts` | `stamps` is nullable, null meaning "not asked, or no answer", like `address`, `wallet` and `chainState` beside it, and any failed fetch clears it. Without that distinction a slow or briefly unreachable node reads as a node with a dead batch. |
| `src/urls.ts` | `hostFor` prefers the profile's `network_host`, the deploy target already resolved server-side, over the raw `host`, so component links and the SRT publish URL point at an address rather than at an ssh alias. |

The components this table named when it was written, `LadderCard`, `UploaderCard`,
`UploadersView`, `AbrPoolForm` and `NewDeploymentDrawer`, were replaced by the UX
rework the day after (PR #39) and no longer exist. The rows above are the files
that carry the same behaviour now.

## Why the pool form is a separate component

The pool briefly lived as a checkbox inside the main drawer, and that produced a
form which lied about what it would create: **Kind**, **Components** and **Media
engine** kept rendering, so the drawer showed "viewer / client + bee-gateway"
while the server, which fixes a pool's components to `bee-uploader`, was going
to create four Bee nodes. The group-name hint promised `<group>-profile-1` names
that a pool never uses.

Every one of those was a missing `!ladderMode` guard. A pool shares almost
nothing with a streaming-infra deployment (no kind, no components, no engine, no
feed, no key, no stamp, fixed size), so expressing it as conditionals inside the
other form meant one guard per irrelevant field, and the failure mode of a missed
guard was a form that quietly contradicted reality.

`AbrPoolForm` has nothing to guard: the fields that do not apply are simply not
in the file. The drawer picks a form, and each form owns its own state, validation
and submit.

## Rung validity

Three things have to be true before a rung can accept an upload, and the ladder
originally asserted all three from stored state rather than checking any of them:
its **node is running**, its **address is reachable**, and its **batch is alive**.
Readiness now checks each, in that order, the order the operator has to fix them
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
paste-ready `BEE_PUBLISHERS`, and still offered **Deploy uploader**, while every
rung's stamp table sat empty and every upload failed.

So anything that claims a rung is ready asks its node. `stampHealthFrom`
(`common/src/stampHealth.ts`) classifies the answer into one state:

| State | Meaning | Blocks readiness |
|---|---|---|
| `none` | No batch recorded on the profile. | yes |
| `active` | On the node, usable, time left. | no |
| `pending` | On the node, bought too recently to be usable. | yes |
| `expired` | On the node, `batchTTL` is 0. | yes |
| `gone` | Recorded, but the node does not have it, expired and dropped, or never bought there. | yes |
| `unknown` | The node was not asked, or could not answer. | **no** |

`unknown` is the state that keeps the fix honest in both directions. A node being
unreachable is not evidence that its batch is dead, so it must not raise an alarm
It is not evidence the batch is *alive* either, so it must not read as
"set". It renders as an explicit *unverified*, on the rung and on the assembled
value.

`batchTTL` needs care: bee returns `0` for a spent batch but a **negative** value
when it cannot work the TTL out, which is not the same thing. Only `0` means
expired.

The frontend holds the same distinction in its own state: `useBeeUtils` exposes
`stamps` as `BeeStamp[] | null`, null meaning "not asked, or no answer", and a
failed fetch clears it rather than leaving the last answer standing. A list nobody
can currently confirm is not evidence, and a stale one shown under a "bee node
unreachable" banner contradicts it. Both halves of that were got wrong first time
(see PR #33 review): a `stampsLoaded` flag latched true, so a node that stopped
answering kept reading as verified, and the stamps table treated its initial empty
array as an answer, so it claimed a dropped batch before any request had been made.

The TTL is also carried back rather than discarded, so a batch can be reported
**before** it runs out: within `STAMP_EXPIRY_WARNING_SECONDS` (48h) the rung reads
`Expires in 6h` and the ladder warns without withholding the value. Expiry itself
was only ever discoverable after everything had already stopped.

### The address

**Corrected 2026-09-17.** The host half of a rung's URL used to be the manager's
public address, on the theory that the uploader reading it runs on another
machine. The uploader this manager deploys does not: it is a container on this
same host, and the T06 bind step in `deploy/README.md` puts every local Bee API
on the Docker bridge address and on nothing else. So the first real pool on the
live host was handed `http://<public host>:10015` and its three siblings, and
nothing answered there from the host, from a container or from anywhere. The
manager's own probe said so, every rung read "Publishing is not verified", and
the uploader restarted in a loop against a pool it could not reach.

What the string carries now is the address a container on this host reaches such
a node on, from `resolveLocalPublisherHost` in `src/domain/localHost.ts`:

- `BEE_LOCAL_HOST` when the operator set it, taken as given. The one exception is
  the bare name `host.docker.internal`, which is resolved the way the next case
  resolves it.
- otherwise, when the manager itself runs in a container, the IPv4 address
  `host.docker.internal` resolves to in there, which is the bridge, handed on as
  a literal. The name itself cannot be handed on, because an uploader's compose
  service carries no `extra_hosts` and the name resolves nowhere inside it on
  Linux. A lookup that fails answers the name and logs one warning.
- otherwise, running natively, the name `host.docker.internal`, which Docker
  Desktop resolves inside a container.

`beePublishersForGroup` reads that once for the whole pool, and the default
reader resolves once per process, since a bridge address does not move while the
manager runs. A member on a **declared remote host** keeps that host's own
address, and the T06 caveat travels with it: that node's API has to be bound
somewhere this host can reach, which its own operator decides. An uploader
running off this host needs an address this manager does not compose, and giving
it one is `BEE_LOCAL_HOST` plus a bind that admits it.

The URL is still arithmetic, that host plus `10005 + slot*10`, so it always
*looks* like an address whether or not anything is there. Two ways it goes wrong
are provable without touching the network, which matters because both are
otherwise silent:

- **A loopback host.** Only `BEE_LOCAL_HOST=127.0.0.1` produces one now, and it
  assembles perfectly and works nowhere but the manager's own machine. The
  structural check still refuses it, and since f60b93c its message names
  `BEE_LOCAL_HOST` and the bridge address, which is where such a value comes from.
- **An ssh target used as a network address.** `profiles.host` holds a *deploy*
  target: the schema validates it against `[a-zA-Z0-9._@-]` and documents it as
  "localhost, an ssh alias, or user@host". `user@host` composed to
  `http://deploy@1.2.3.4:10055`, not a bee base URL, and a stray `@` inside an
  entry format that already separates the rung from the URL on `@`.

The second is now *fixed* rather than merely detected: `resolveNetworkHost`
composes both URLs out of the target's address half. The userinfo is dropped,
because the ssh account provably is not part of the address. A *dotless* name is
resolved as an ssh alias: `ssh -G <name>` against the config the api container
mounts, reading back the `hostname` it would dial, which is exactly what
deploy.sh's `host_from_target` does with the same value, so a rung is dialled at
the address it was deployed to. A literal or a dotted name is taken as given, and
a name no Host block matches comes back unchanged, so resolution can only improve
on the address and never lose one. Results are cached for 60s, since the config is
a bind mount an operator edits without restarting the manager. The structural
check in `classifyPublishUrl` stays as the guard on a permissive field.

The same resolved value reaches the browser as `network_host` on each profile,
which is what the component links and the SRT publish URL are built from. An
alias resolves in the manager's ssh config and nowhere else, least of all in a
browser.

The third way, well-formed but nothing listening, needs a probe, and the probe
targets the **published** URL, not `beeApiUrlFor`. That is the whole point: the
manager reads a local node at its own `BEE_LOCAL_HOST` or docker host alias,
which is not always the address the pool string carries, so verifying a batch
proves nothing about the address the uploader is handed. When those two disagree
the ladder looks complete and no upload lands.

A failed probe **warns** rather than blocks: for a remote member NAT hairpinning
explains it as well as a wrong address does, and for a local one the manager and
the uploader are two containers with two routes to the same port.

**An uploader created before 2026-09-17 holds the old string**, since the value
is copied into its settings when the pool is picked. The pool page's "Copy pool
string" assembles the new one, and pasting it into the uploader's "Node pool
string" field under Edit replaces the old.

### The node

`LadderRungState.status` was carried through the response and then ignored, and
the Uploaders tab, being about batches, showed no status at all, so a stopped
rung looked exactly like a running one. Only `RUNNING`
(`PUBLISHABLE_RUNG_STATUS`) is publishable, and anything else blocks with the state it
is actually in, and the card grows a status chip *when it is not running*, since a
chip on every healthy row would bury the one row that needs attention.

### Blocking versus warning

| | Blocks the value | Warns, value still served |
|---|---|---|
| Node | not `RUNNING` | none |
| Address | `loopback`, `ssh-target`, `malformed` | `unreachable` |
| Batch | `none`, `pending`, `expired`, `gone` | `unknown`, expiring within 48h |

The right-hand column is the honest half. Every entry there is something we could
not confirm rather than something we found wrong, and treating "could not check"
as "broken" would trade one false claim for another. Warnings are reported only
for rungs not already blocked, one complaint per rung, and it is the actionable
one.

## Guards

Two group-level operations were written for plain fan-out groups and would
quietly corrupt a ladder. Both now refuse with a 409:

1. **`updateGroupConfig` bulk-applies `stamp_id` to every member.** On a ladder
   that hands all four rungs the same batch, precisely the failure a node per
   rung exists to prevent, since the batches are deliberately different sizes.
   Other shared fields stay bulk-editable.
2. **`addGroupMembers` names new members `<group>-profile-N`**, which is not a
   rung name, so the member would sit in the group without ever being part of the
   ladder.

Both guards key off `deployment_groups.kind` rather than the member names, so a
ladder that has already lost a rung still refuses them. Deriving ladder-ness from
names would have dropped both guards at exactly the wrong moment, letting
`addGroupMembers` append a `-profile-N` member to a ladder that was mid-repair.

## Known gaps

1. **Nothing enforces ladder integrity after creation.** Any rung can be stopped
   or removed individually, leaving a 3-rung ladder. The ladder card reports
   which rung is missing. Nothing prevents it.
2. **Ports are not dense.** Four slots at 10 ports each = 40 reserved to use 8.
   Deliberate: it is the price of a rung being an ordinary profile. At the
   manager's cap of 100 slots that is 25 ladders on one host.
3. **The Bee API is unauthenticated**, and the uploader must reach all four rung
   API ports. A private network is the intended path rather than public exposure.

## Future work

- An automatic stamp-manager layer: top up or re-buy a rung's batch before it
  expires, instead of the manual per-rung buy. Expiry is now *visible* rather
  than silent, but the repair is still four manual buys.
- Liveness on the Deployments tab. `pendingStamp` there is still derived from the
  column alone, because reporting it honestly would mean probing every profile's
  node on every list. The Uploaders tab is the one place that asks.
- Reachability *from the uploader* rather than from the manager. The probe can
  only tell you what the manager can reach, which is why an unreachable published
  address warns instead of blocking. A check run from where the uploader actually
  lives would be conclusive.
- Failover in `BeePublisherPool`: losing the coordinator currently blocks new
  viewers from joining while existing ones play on.
