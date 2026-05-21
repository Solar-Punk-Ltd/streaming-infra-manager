# Group Deployment

Provision N deployments at once from a single form, grouped under a user-named umbrella, sharing all configuration parameters.

## Motivation

The single-profile `New deployment` flow is fine for one-off setups, but exercising the streaming pipeline at scale (fan-out testing, viewer load tests, multi-replica streamer experiments) requires creating many near-identical profiles by hand. Group deployment collapses that into a single form submission.

## Scope (prototype)

In scope:
- A "group mode" toggle on the existing `NewDeploymentDrawer`.
- A new `deployment_groups` table; profiles get a nullable `group_id`.
- A `POST /groups` endpoint that transactionally persists the group + N member profiles, then kicks off deployments for each.
- Collapsible group rows on the deployments table.

Out of scope (deferred):
- Group-level lifecycle operations (bulk start / stop / destroy / redeploy / edit). Members are operated on individually after creation.
- Adding or removing members from an existing group.
- Distributing members across multiple hosts.
- Per-member overrides of shared parameters.

## Data model

New table:

```
deployment_groups
  id          INTEGER PRIMARY KEY
  name        TEXT NOT NULL UNIQUE
  size        INTEGER NOT NULL
  created_at  TEXT NOT NULL
```

`profiles` gains a nullable `group_id INTEGER REFERENCES deployment_groups(id)`.

Group rows are immutable metadata. The shared parameter values are not snapshotted on the group row — they live on each member profile, exactly as they would for a single deployment. This keeps per-member operations (edit, redeploy) unchanged.

## Member naming

The user supplies a group name (e.g. `loadtest`). Members are named `${groupName}-profile-${N}` starting at `N = 1`. If a profile name is already taken (collision with a pre-existing single profile, or a prior group with the same prefix), `N` advances until N distinct unused names are found. Group name itself is globally unique.

## Shared fields

All form fields filled in group mode are applied verbatim to every member:

- `kind`, `components`, `host`, `notes`
- `feed_owner`, `feed_topic` (when `client` is selected)
- `private_key`, `stamp_id` (when `stream-uploader` is selected); `public_key` is derived

Members differ only in `name` and `group_id`.

### Known caveat: shared streamer identity

When `stream-uploader` is part of a group, all members write to the **same Swarm feed with the same private key**. This is rarely what you want for a real workload — the prototype permits it deliberately so you can stress-test viewer fan-out without inventing a per-member key story. A future iteration may auto-generate per-member keys or block group mode for streamer kinds.

## Execution flow

The `POST /groups` handler runs in two phases:

1. **Persist.** Open a transaction, insert the group row, insert N profile rows referencing it. If any row fails (name collision, validation), the entire transaction rolls back and the API returns an error before any deploy is kicked off.
2. **Deploy.** With profiles committed, dispatch the existing per-profile deploy path for each member. Per-member deploy outcomes surface through the existing SSE event stream and per-row status chips. A member that fails to deploy stays in the database as a profile that can be retried individually.

The endpoint returns as soon as phase 1 succeeds and phase 2 has been kicked off — it does not block on every member finishing.

## Frontend changes

### `NewDeploymentDrawer`

- New checkbox: **"Deploy as group"**.
- When enabled:
  - `Name` label becomes `Group name` (same regex as profile name).
  - New numeric input: `Size` (default 2).
  - When `Size > 20`, an inline warning chip appears: *"Large group — N profiles will be created and deployed."*
  - The submit button label becomes `Deploy group`.
  - All other fields keep their existing semantics.
- Group mode is hidden in edit mode (`selectedProfile` present).

### `DeploymentsTable`

- Members with the same `group_id` collapse under a group header row.
- Group header shows: group name, member count, created_at, expand/collapse caret.
- Per-row actions on individual members remain unchanged.
- Profiles with `group_id = null` continue to render as flat rows.

## Backend changes

| File | Change |
|---|---|
| `manager/src/domain/Database.ts` | Migration: create `deployment_groups`, add `group_id` to `profiles`. |
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
| `frontend/src/types.ts` | `DeploymentGroup` type, `group_id?: number` on `Profile`. |
| `frontend/src/data.ts` | `createDeploymentGroup`, `listGroups`. |
| `frontend/src/NewDeploymentDrawer.tsx` | Group-mode toggle, size input, branching submit. |
| `frontend/src/DeploymentsTable.tsx` | Collapsible group row rendering. |

## Validation rules

- Group name: same regex as profile name (`^[a-z0-9][a-z0-9-]{0,30}$`), globally unique across `deployment_groups.name`.
- Size: integer ≥ 1. No hard upper bound; warning over 20.
- All field-level validation from single-profile mode applies unchanged.
- Phase-1 transaction rolls back on any profile-row failure.

## Open questions / future work

- Per-member secret generation (private keys, stamp ids) for genuine streamer fan-out.
- Group-level bulk operations (destroy / redeploy / edit shared params).
- Multi-host distribution.
- Adding members to an existing group post-hoc.
- Surfacing aggregate group status (e.g. `3/5 running`) on the group header row.
