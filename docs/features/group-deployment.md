# Group Deployment

Status, 2026-09-16: built and merged to `main-v2`. The page opens with the prototype scope it was
written for, and the paragraph after it records what has been built since. Corrected 2026-09-23
against the code at `87673c99`: "Shared fields", which left out five fields every member is
given and the port slot each member takes for itself.

Provision N deployments at once from a single form, grouped under a user-named umbrella, sharing all configuration parameters.

## Motivation

The single-profile `New deployment` flow is fine for one-off setups, but exercising the streaming pipeline at scale (fan-out testing, viewer load tests, multi-replica streamer experiments) requires creating many near-identical profiles by hand. Group deployment collapses that into a single form submission.

## Scope (prototype)

In scope:
- A "group mode" choice in the new deployment flow.
- A new `deployment_groups` table, and profiles get a nullable `group_id`.
- A `POST /groups` endpoint that transactionally persists the group + N member profiles, then kicks off deployments for each.
- Collapsible group rows on the deployments table.

Out of scope (deferred):
- Bulk start, stop, destroy and redeploy. Members are operated on individually after creation.
- Distributing members across multiple hosts.
- Per-member overrides of shared parameters.

Built since this page was written, and no longer deferred: editing a group's shared
settings in one write (`PATCH /groups/:id/config`, the **Edit group** drawer), adding
members to an existing group (`POST /groups/:id/members`) and removing a group once it
has no members left (`DELETE /groups/:id`). An ABR node pool refuses the first two,
because a bulk `stamp_id` would hand every rung the same batch and a new member would
not carry a rung name. See [abr-ladder.md](abr-ladder.md).

## Data model

New table:

```sql
CREATE TABLE deployment_groups (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deployment_groups_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT deployment_groups_size_positive CHECK (size >= 1)
);

ALTER TABLE profiles
  ADD COLUMN group_id INTEGER REFERENCES deployment_groups(id) ON DELETE SET NULL;
```

That is `manager/src/migrations/002_deployment_groups.sql`, which also indexes
`profiles (group_id)`. A later migration, `004_group_kind.sql`, adds the `kind`
column the ABR work uses.

Group rows are immutable metadata. The shared parameter values are not snapshotted on the group row, they live on each member profile, exactly as they would for a single deployment. This keeps per-member operations (edit, redeploy) unchanged.

## Member naming

The user supplies a group name (e.g. `loadtest`). Members are named `${groupName}-profile-${N}` starting at `N = 1`. If a profile name is already taken (collision with a pre-existing single profile, or a prior group with the same prefix), `N` advances until N distinct unused names are found. Group name itself is globally unique.

## Shared fields

All form fields filled in group mode are applied verbatim to every member:

- `kind`, `components`, `host`, `notes`
- `feed_owner`, `feed_topic` (when `client` is selected)
- `private_key`, `stamp_id` (when `stream-uploader` is selected), and `public_key` is derived
- `srt_passphrase`, so every member takes the same SRT passphrase
- `node_mode`, `rpc_endpoint_source` and `rpc_endpoint`, one chain answer for the whole group. A
  source the body leaves out is worked out once, for every member
- `stack_version_id`, the default version when the body names none, so every member runs one
  version
- `engine_settings`, so every member cuts the same segments
- `stack_settings`, so every member starts with the same stack settings, a node pool's rungs
  included

Members differ in `name` and in their port slot, which each takes for itself as it is inserted:
the lowest free slot, with the ports that slot reserves (`insertMemberWithFreeSlot` in
`manager/src/domain/DeploymentGroupRepository.ts`). All of them carry the group's `group_id`.

A group's members start with the engine settings the create body carries, and the wizard
pre-fills a two-second segment length wherever the deployment runs SRS, so the whole group
cuts the same lengths instead of falling back to whatever its stack version does. A member
added later takes the settings its siblings already run. An ABR node pool carries no engine
settings, because it is Bee nodes and no media server, and a create body that sends engine settings
for one is refused with the sentence a single deployment with no engine gets.

### Known caveat: shared streamer identity

When `stream-uploader` is part of a group, all members write to the **same Swarm feed with the same private key**. This is rarely what you want for a real workload. The prototype permits it deliberately so you can stress-test viewer fan-out without inventing a per-member key story. A future iteration may auto-generate per-member keys or block group mode for streamer kinds.

## Execution flow

The `POST /groups` handler runs in two phases:

1. **Persist.** Open a transaction, insert the group row, insert N profile rows referencing it. If any row fails (name collision, validation), the entire transaction rolls back and the API returns an error before any deploy is kicked off.
2. **Deploy.** With profiles committed, dispatch the existing per-profile deploy path for each member. Per-member deploy outcomes surface through the existing SSE event stream and per-row status chips. A member that fails to deploy stays in the database as a profile that can be retried individually.

The endpoint returns as soon as phase 1 succeeds and phase 2 has been kicked off, and it does not block on every member finishing.

## Frontend changes

### The new deployment flow

As designed in 2026-05. The drawer is now a wizard, see the module table below.

- New checkbox: **"Deploy as group"**.
- When enabled:
  - `Name` label becomes `Group name` (same regex as profile name).
  - New numeric input: `Size` (default 2).
  - Above a size of 20 an inline warning appears: *"Large group, double check before deploying."*
    (`LARGE_GROUP` in `frontend/src/forms/wizard/steps/BasicsStep.tsx`.)
  - The submit button label becomes `Deploy group`.
  - All other fields keep their existing semantics.
- Group mode is hidden in edit mode (`selectedProfile` present).

### The deployments table

- Members with the same `group_id` collapse under a group header row.
- Group header shows: group name, member count, created_at, expand/collapse caret.
- Per-row actions on individual members remain unchanged.
- Profiles with `group_id = null` continue to render as flat rows.

## Backend changes

| File | Change |
|---|---|
| `manager/src/migrations/002_deployment_groups.sql` | Create `deployment_groups`, add `group_id` to `profiles`. |
| `manager/src/domain/ProfileRepository.ts` | Read group_id alongside other fields. |
| `manager/src/domain/DeploymentGroupRepository.ts` (new) | `createGroupWithMembers(...)` in a single transaction. |
| `manager/src/domain/ProfileService.ts` | `createGroup(...)` orchestration: validate, transact, dispatch deploys. |
| `manager/src/schemas/profile.ts` | Add `createGroupSchema` (yup) for `POST /groups`. |
| `manager/src/api/routes/groups.ts` | `POST /groups`, `GET /groups`. |
| `manager/src/api/server.ts` | Mount `/groups` router. |
| `manager/src/api/middleware/errorHandler.ts` | Map `GroupExistsError` → 409. |

## Frontend module touches

| File | Change |
|---|---|
| `frontend/src/types/interfaces.ts` | `DeploymentGroup` type, `group_id?: number` on `Profile`. |
| `frontend/src/data.ts` | `createDeploymentGroup`, `listGroups`. |
| `frontend/src/forms/wizard/` | Group size and the branching submit, as steps of the new deployment wizard. |
| `frontend/src/deployments/GroupBlockRows.tsx` | Collapsible group row rendering on the deployments page. |
| `frontend/src/groups/GroupPage.tsx` | A group's own page, with its shared settings and members. |

The first four rows named `frontend/src/types.ts`, `NewDeploymentDrawer.tsx` and
`DeploymentsTable.tsx` when this page was written. The UX rework (PR #39) replaced
the drawer with a wizard and split the table, so the files above are where that
behaviour lives now.

## Validation rules

- Group name: same regex as profile name (`^[a-z0-9][a-z0-9-]{0,30}$`), globally unique across `deployment_groups.name`.
- Size: integer ≥ 1. No hard upper bound, and a warning over 20.
- All field-level validation from single-profile mode applies unchanged.
- Phase-1 transaction rolls back on any profile-row failure.

## Open questions / future work

- Per-member secret generation (private keys, stamp ids) for genuine streamer fan-out.
- Group-level bulk destroy and redeploy. Editing shared parameters was built, and
  so was adding members, both listed under Scope above.
- Multi-host distribution.
