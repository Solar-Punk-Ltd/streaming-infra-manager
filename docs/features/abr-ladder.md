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
| that this group is a ladder | `deployment_groups.kind = 'abr-ladder'` — one new column |
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

Intent is a fact about the group and belongs in a column. Current shape stays
derived: `isLadderKind(group.kind)` answers "is this a ladder", and
`isLadderGroup(name, memberNames)` answers the different question "is it
complete". Using the second for identity is the bug the column removes.

## Using it

1. **New deployment → Deployment type → ABR Uploader Pool.** Four profiles are
   created: `<pool>-360p` … `<pool>-1080p`, each with the single `bee-uploader`
   component.
2. **Deploy each rung.** Group creation inserts members as `STOPPED`; the
   orchestrator is not invoked (see [Known gaps](#known-gaps)).
3. **Uploaders tab.** The ladder card lists its four rungs, each expandable —
   fund its address with xDAI and xBZZ, then buy its batch. The buy form starts
   at that rung's suggested depth (**17 / 18 / 19 / 20** across the shipped
   ladder), because a rung's batch fills in proportion to its bitrate and a flat
   depth would put the four expiries hours apart.
4. **Copy `BEE_PUBLISHERS`** from the ladder card once all four rungs report a
   batch, and set it in the uploader's env alongside `ABR_ENABLED=true`.

## Implementation

### `common`

| File | Change |
|---|---|
| `src/abrLadder.ts` (new) | The whole ladder domain: `DEFAULT_ABR_LADDER` (rungs, geometry, kbps), `ladderMemberName` / `rungFromMemberName` / `ladderMemberNames`, `isLadderGroup` / `looksLikeLadderGroup`, `rungOrder`, `suggestedRungDepth`, `assembleBeePublishers`, `beePublishersValue`, `LADDER_GROUP_NAME_MAX`. |
| `src/abrLadder.test.ts` (new) | 29 tests over naming, round-tripping, group recognition, depth scaling and assembly — including that the name cap is exactly where member names stop fitting. |
| `src/stampGating.ts` | `isBeeNodeOnly` and `managesOwnStamp`. A rung has no `stream-uploader`, so the old gate said it needed no stamp — which would have left it invisible on the Uploaders tab with no way to fund it. |

### Manager

| File | Change |
|---|---|
| `src/schemas/profile.ts` | `abr_ladder` flag; group-name length rule that applies only to ladders. |
| `src/domain/ProfileService.ts` | Ladder member seeding (names fixed, components fixed to `bee-uploader`); `ladderMembersOf`; `beePublishersForGroup`; guards on `updateGroupConfig` and `addGroupMembers`. |
| `src/domain/StampService.ts` | `beePublicApiUrlFor` — the URL an off-host uploader can reach, as opposed to `beeApiUrlFor`, which resolves a local profile to `host.docker.internal`. |
| `src/domain/errors/LadderGroupError.ts` (new) | 409 `ladder_group_invalid_operation`. |
| `src/api/routes/groups.ts` | `GET /groups/:id/bee-publishers`. |
| `test/unit/ladderSchema.test.ts` (new) | Pins the cross-field name rule, which uses yup's `this.parent` and would fail silently if the schema shape changed. |

`beePublishersForGroup` makes **no bee calls** — every field comes from the
profile rows plus the resolved public host, so it cannot be slowed or failed by a
node being down. Live batch state already has a home: the per-rung uploader cards.

### Frontend

| File | Change |
|---|---|
| `src/uploaders/LadderCard.tsx` (new) | The assembled `BEE_PUBLISHERS` with a copy button (or exactly which rungs are holding it up), then each rung's own `UploaderCard` nested beneath, expandable one by one. |
| `src/uploaders/UploaderCard.tsx` | Generalised with three optional props — `label`, `badges`, `defaultDepth` — plus `nested` for elevation. Standalone use is unchanged. |
| `src/uploaders/BuyStampForm.tsx` | Optional `defaultDepth`, so a rung's form starts at *its* suggested depth rather than a flat 17. |
| `src/uploaders/UploadersView.tsx` | Ladder cards first (selected by `group.kind`, so a damaged ladder still appears), then every profile that manages its own stamp — which now includes bee-only rungs. |
| `src/uploaders/UploaderCard.tsx` | Also hides "Deploy uploader" and the SRT publish URL for a bee-only profile: it runs no uploader and no media engine, so it has nothing to ingest on. |
| `src/AbrPoolForm.tsx` (new) | The entire pool form, self-contained. |
| `src/NewDeploymentDrawer.tsx` | A top-level **Deployment type** combobox — *ABR Uploader Pool* / *Streaming Infra* — that swaps in `AbrPoolForm` wholesale. The old `ladderMode` boolean is gone. |
| `src/data.ts` | `fetchBeePublishers`, returning `null` for a group that is not a ladder so callers can probe cheaply. |

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
  expires, instead of the manual per-rung buy.
- A group-level deploy action, which would also fix gap 1 for ordinary groups.
- Failover in `BeePublisherPool`: losing the coordinator currently blocks new
  viewers from joining while existing ones play on.
