# Stack versions: several swarm-hls-stream versions side by side

Status: decided 2026-09-05 (D9 upstream hook wanted, D10 sibling folder, D11 adopt main-v3). D12
is on hold, so the per version image tags use the shared tag fallback with a build mutex until the
upstream hook is allowed. Three PRs against `main-v2`. **PR 1 is built on `feat/stack-versions`:**
the versions table with the bundled row, per version paths, the Versions page, add and update with
the build script, and the contract reader. Every deployment still runs the bundled version. PR 2
and PR 3 are not started.

## Where we are

The manager runs exactly one copy of the streaming stack: the git submodule at
`manager/swarm-hls-stream`, pinned to `main-v2` at commit `ee99c36`. Its path is one constant
(`SUBMODULE`, overridable by `SHLS_ROOT`), every deploy script, env file and compose file is
resolved from it, and the port table the manager uses to predict container ports is a copy of
that version's table, hardcoded in `DeploymentOrchestrator` and `containerKeysSpec`.

The images are built on every deploy with fixed names, `stream-uploader:latest` and
`stream-client:latest`, whatever profile triggers the build. The uploader image copies a `dist/`
that `deploy/deploy.sh` builds on the laptop and rsyncs to the host, the client image builds from
source inside Docker.

Upstream has moved. `main-v3` carries 1095 commits that `main-v2` does not, and its deploy
contract differs in ways the manager must know about, all read from the branch on 2026-09-05:

| Contract point | `main-v2` (pinned) | `main-v3` |
|---|---|---|
| Port table | nine variables, last digit 0 to 8, base 10000 | ten variables, `SRS_HTTP_API_PORT` at digit 9, plus a second band 11001 to 11006 for per rung Bee nodes, entries carry a third field |
| Slot range | 1 to 999 | 1 to 99, refused above |
| Required secrets | none | `API_AUTH_TOKEN` (uploader API, 32+ chars, refuses to start without) and `SRS_WEBHOOK_TOKEN` (SRS to uploader webhooks, 32+ chars, the entrypoint exits without it) |
| Optional secret | | `PUBLISH_KEY_SECRET`, publisher authentication, off when empty |
| Gates | none | `CHEQUEBOOK_MIN_BZZ` 0.5, `STAMP_MIN_TTL_HOURS` 24, `STAMP_MAX_UTILIZATION` 0.9, the uploader refuses to start below them |
| Engine knobs | `HLS_FRAGMENT` 1.5, `HLS_WINDOW` 22.5 | `HLS_FRAGMENT` 0.5, `HLS_WINDOW` 15, plus `SRT_LATENCY`, `HLS_AOF_RATIO` |
| Bee image | 2.8.1 | 2.8.2 |
| Uploader image build | copies prebuilt `dist/` | same, still needs a build outside Docker |

A "version" is therefore not just a git ref. It is a ref pinned to a commit, built once, with a
contract the manager reads instead of assuming.

## What the operator sees

- A new sidebar page **Versions** (`#/versions`). A table: name, branch or tag, commit (short),
  built when, state (Ready, Building, Failed), how many deployments run it, and a Default badge.
  Buttons per row: **Update** (fetch the branch head again and rebuild, the pinned commit moves
  only then), **Set as default**, **Remove** (refused while any deployment uses it). At the top
  **Add version**: a name (defaults to the branch name, letters, digits and dashes) and a branch
  or tag. Adding streams the clone and build log live, the way a deploy does, and the row goes
  Building then Ready or Failed with the last lines of the log.
- The built-in version is listed as **bundled** (`main-v2 @ ee99c36`), always present, the
  default until another is chosen. Every existing deployment runs it. Nothing changes for them.
- **Set as default** records which version the new deployment wizard will preselect. It takes
  effect on new deployments in PR 2, the one that gives the wizard its Stack version select.
  In PR 1 every deployment created still runs the bundled version whatever the badge says, so
  the confirmation dialog says so, and only a version marked **Tested** can be made the default.
- **New deployment wizard**, Basics step: a **Stack version** select, preselected to the default,
  hidden when only one version exists. Its help text shows the branch and commit.
- **Deployment page**, At a glance: `Version main-v3 @ be440d6`. A **Move to another version**
  action in the header menu: a dialog listing versions, with `Recreates every container of this
  deployment on the chosen version. The Bee node's data and keys stay, they live on the host, not
  in the image.` The deployment goes Deploying and comes back on the new version. For a group
  member the dialog moves the whole group, one version per group.
- **Deployments list**: a version chip on each row when more than one version exists, and a
  filter chip per version.
- After an **Update** of a version, its row says `3 deployments behind` until they are redeployed
  (Start or Move to the same version does it), because running containers keep the images they
  were started from.

## Design

### Storage

Migration `010_stack_versions.sql`:

```sql
CREATE TABLE stack_versions (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  git_ref      TEXT NOT NULL,
  commit_sha   TEXT,
  status       TEXT NOT NULL DEFAULT 'building',
  root_path    TEXT NOT NULL,
  contract     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  built_at     TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stack_versions_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT stack_versions_status_known CHECK (status IN ('building', 'ready', 'failed'))
);
CREATE UNIQUE INDEX stack_versions_one_default ON stack_versions (is_default) WHERE is_default;

INSERT INTO stack_versions (name, git_ref, status, root_path, is_default)
VALUES ('bundled', 'main-v2', 'ready', '<SHLS_ROOT>', true);

ALTER TABLE profiles ADD COLUMN stack_version_id INTEGER REFERENCES stack_versions(id);
UPDATE profiles SET stack_version_id = (SELECT id FROM stack_versions WHERE name = 'bundled');
ALTER TABLE profiles ALTER COLUMN stack_version_id SET NOT NULL;

ALTER TABLE profiles ADD COLUMN stack_secrets JSONB NOT NULL DEFAULT '{}'::jsonb;
```

The bundled row's `root_path` is filled at migration time from the running config, and its
`commit_sha` from `git rev-parse` in the submodule (or from `.git` when it is a plain checkout on
the host). `stack_secrets` holds the per deployment values a version requires (`API_AUTH_TOKEN`,
`SRS_WEBHOOK_TOKEN`), generated with `crypto.randomBytes(32).toString('hex')` at creation when
the contract lists them, written into `.env.<profile>` at deploy, never returned by the API.

### Where versions live on the host (decision D10)

`STACK_VERSIONS_ROOT`, default `/home/solarpunk/streaming-infra-manager-versions`, a sibling of
the data root, bind-mounted into the api container at the same absolute path, the rule every
compose file under a version already relies on. It is outside the tree that `deploy/deploy.sh`
rsyncs with `--delete`, so a manager deploy cannot wipe it. Each version is
`<root>/<name>/` and holds a full checkout with its dependencies installed and its packages
built, about one gigabyte each.

### Adding and building a version

`POST /versions { name, ref }` inserts the row and runs `manager/scripts/stack-version-build.sh
<root> <ref>` through the existing `ScriptRunner`, streamed as SSE like a deploy, with a
`version.changed` event on the event bus when it ends. The script:

1. `git clone --branch <ref> --single-branch https://github.com/Solar-Punk-Ltd/swarm-hls-stream.git
   <root>` on first add, `git fetch && git checkout <ref> && git reset --hard origin/<ref>` on
   Update. Records `git rev-parse HEAD`.
2. Exports that commit into `<root>.staging` with `git archive`, and builds the packages there in
   a throwaway container, not in the api image, so the api image stays as it is: `docker run
   --rm --memory 4g --cpus 2 --pids-limit 512 -v <staging>:<staging> -w <staging> node:22-alpine
   sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm -r build'`. The same host
   path on both sides is what makes the bind work from inside the api container, exactly like the
   deploys. The staging tree rather than the root, because the root holds every deployment's
   `.env.<profile>` with `STREAM_KEY`, `SRT_PASSPHRASE` and `STAMP` in it, and inside that
   container the followed branch runs its own install and build scripts. The built tree is then
   rsynced back into the root with `.git`, `.env`, `.env.*`, `deploy/config.json`,
   `deploy/.env.deploy*` and `engines/*/.env*` excluded, so `dist` and `node_modules` land where
   the deploy scripts read them and every env file survives. Adding a version therefore runs that
   branch's deploy scripts with the manager's Docker access, which the Versions page says.
3. Copies `.env.sample` to `.env` and `deploy/config.sample.json` to `deploy/config.json` when
   missing, which `bootstrapSubmoduleDefaults` does today for the one root and will do per root.
4. Reads the contract (below) and writes it to the row. Status `ready`, or `failed` with the log
   tail as `last_error`.

The api image gains `git` (one apk line). Two builds never run at once: a mutex in
`StackVersionService` serialises them, and a version in `building` state cannot be chosen for a
deployment.

### Immutable builds and an identified running build (T04a, 2026-09-08)

The build described above moved the checkout in place, so a failed update left a mixed tree, a
deploy admitted during the update ran on it, and a container restart picked up new files under an
old container. Migration `015_stack_builds.sql` and the code around it change that.

**Layout.** A version with builds keeps three sibling directories under `STACK_VERSIONS_ROOT`.
`<name>/` is the flat root it always had: the host-owned inputs live there (`.env`,
`deploy/config.json`, `engines/<engine>/.env`), and a row still on the old layout deploys from it.
`<name>.repo/` is the clone, which only fetches and is never deployed from. `<name>.builds/<id>/`
is one immutable directory per build, `<id>` being the commit or `<commit>-r<n>` for the same
commit published again with other inputs. A dot cannot appear in a version name, so the flat root
is never an ancestor of a build. A build carries `.stack-manifest.json` (commit, build id, built
at, toolchain, the generation and hashes of the inputs copied in) and a `.complete` marker written
last. `stack_versions.layout` is `legacy` for every row that exists when the migration runs and
`builds` from a row's first publication on. A `builds` row deploys from `build_id` and refuses,
naming the build, when that directory is missing or incomplete. It never falls back to the flat
root. `previous_build_id` is the build the current one replaced.

**Building.** `stack-version-build.sh <repo-root> <staging-dir> <ref> <repo-url> <attempt-id>`
fetches into the clone, exports the commit into the attempt's own staging directory
(`<name>.builds/tmp-<attempt>`), builds it in a container named `stack-build-<attempt>`, leaves
the commit in `.stack-commit` and publishes nothing. The manager then captures the version's host
configuration (below), copies it into the staging tree, writes the manifest and the marker,
renames the tree under its identity, or adopts a complete build of the same commit and inputs
untouched, and publishes with one row update under the row's own lock: ready, layout `builds`,
the previous build kept, `tested` surviving only when the build id did not change. A failed
update leaves a row with a usable build ready with the reason. Files under a published path are
never replaced. At boot a staging directory is removed only when Docker says no container of its
name exists, so a builder that outlived the manager keeps its tree.

**Host configuration.** The inputs are edited through `manager/scripts/stack-config-edit.sh
<root> set <file> <source>...` or `... commit`, which holds `<root>/.config.lock` (an atomic
`mkdir`) for the whole edit, replaces each file beside itself and renames over it, and writes
`.config-revision.json` last, with a generation and every file's hash. Capture takes the same
lock with a bounded wait, reads every listed file between two stats, checks the base env against
the build's `.env.sample` keys and the deploy config as JSON, compares every hash to the manifest
and refuses naming the file on any difference, so a build can never carry one new file and one
old. An edit outside the script is refused by hash until it is committed with the script. A root
without a manifest is adopted at generation one from its current bytes, recorded as such.
`--unlock` removes a lock whose editor is gone, by a person who checked.

**References.** A deploy claim reads the version once, moves the profile to `DEPLOYING` and
inserts a `job` reference (`build_references`) for the build it will run, in one transaction under
a share lock on the version row, and hands the run a descriptor: the version as read, the build's
identity and its root. The run deploys from the descriptor and never reads the version again.
After the script, the success hook asks Docker which root each service's container was started
from (the compose working directory label the container carries), writes one `snapshot`
reference per service and resolves every job reference newer snapshots cover. A daemon that does
not answer and a script that fails both keep the job reference. Boot observes every profile with
an open job reference the same way. Prune keeps the current build, the previous one and every
build an open reference names, deletes the other build directories, and runs under the version
row's update lock after a publication and at boot. It never touches a staging directory or the
flat root, which keeps the host-owned inputs.

**What runs.** Each service's container row records the build and the commit it was seen to be
started from, and a profile records `last_full_deploy_commit` only when a deploy touched every
service it has and found every one on that commit. The deployment page shows one commit when
every container agrees and names each service's own when they differ. The Versions page shows
the layout, the current build and the previous one.

Out of scope here: the bundled checkout stays on the old layout until T04b publishes it as builds
of its own, and the legacy flat root is never pruned, because it doubles as the config root.

### Reading the contract

`manager/src/domain/stackContract.ts`, tested against fixtures cut from both branches:

- **Port table**: parse the `readonly PORT_VARS=(` block of `deploy/scripts/_lib.sh`. Entries
  are `NAME:default` (v2) or `NAME:default:slotbase` (v3), comments and blank lines skipped. The
  slot base is the last field. This replaces `PORT_VAR_DEFAULTS` in the orchestrator and the
  key list in `containerKeysSpec`, both of which become functions of the profile's version.
- **Slot cap**: the number in `--portSlot=<N> (1-N)` in `deploy.sh`'s usage text, 999 when
  absent. `insertWithFreeSlot` takes a `maxSlot` and answers `AllSlotsUsedError` with the cap
  named when the lowest free slot exceeds it.
- **Required secrets**: `API_AUTH_TOKEN` when `.env.sample` declares it, `SRS_WEBHOOK_TOKEN`
  when `engines/srs/.env.sample` declares it. Detection is by key presence in the sample files,
  which both branches keep exact.
- **Engine defaults**: `HLS_FRAGMENT`, `HLS_WINDOW` and the rest read from the entrypoint's
  `${VAR:-default}` fallbacks, so the engine settings drawer shows the right defaults per
  version.
- **Features**: `srsApiPort` true when `SRS_HTTP_API_PORT` is in the table (live engine status
  works), `chequebookGate` true when `CHEQUEBOOK_MIN_BZZ` is declared.

The contract is stored as JSON and shown on the Versions page in plain words: `10 ports, slots
1 to 99, needs 2 generated secrets, SRS API published, chequebook gate 0.5 BZZ`. A row also has
a **Tested** toggle Levi sets by hand after one real deployment on that version, because static
reading of scripts proves the shape and not the behaviour.

The approval belongs to the commit that was deployed, not to the row. An **Update** that fetches
a moved branch clears **Tested** again, and one that lands on the commit the row already carried
leaves it alone. The toggle can only be turned on while the version is Ready, because a building
or failed version has no build anybody could have deployed. Turning it off works in any state, so
an approval can always be withdrawn.

### Per version images (decision D9)

With fixed image names two versions rebuild `stream-uploader:latest` in turn. The clean fix is
one extra compose file per version root, `deploy/docker-compose.manager.yml`, written by the
manager:

```yaml
services:
  stream-uploader:
    image: stream-uploader:main-v3-be440d6
  client:
    image: stream-client:main-v3-be440d6
```

and a three line change upstream in `_lib.sh`'s `build_compose_files` that appends
`-f $base/docker-compose.manager.yml` when the file exists. The change goes to `main-v2` and
`main-v3` in one swarm-hls-stream PR. Until it lands, builds stay correct but shared: a global
mutex around every deploy that builds (uploader or client in the service list) prevents two
profiles interleaving a build, at the cost of parallel group deploys waiting on each other.

### Orchestrator

- `SUBMODULE` and the four `SCRIPT_*` constants become `stackPaths(version)` with `root`,
  `deploy`, `stop`, `clean`, `health`, `envFile(profile)`. `DeploymentOrchestrator`,
  `DeploymentGroupRepository` writes and `envUtils` take the version through the profile.
- `PORT_VAR_DEFAULTS` becomes `version.contract.ports`. `omePortsFor` and the OME base ports
  follow.
- `writeProfileEnv` writes `stack_secrets` and the engine settings.
- **Move**: `POST /profiles/:name/move-version { version_id }` and `POST /groups/:id/move-version`.
  Refused while transitional, when the version is not ready, or when the profile's slot exceeds
  the target's cap. Stops the deployment on the old root (`stop.sh` there), rewrites the profile
  row, deploys on the new root. The Bee data directory is keyed by profile name under the data
  root, so the node's identity and its chequebook survive the move.
- Remove of a version: refused with the deployment names when in use, otherwise deletes the row
  and `rm -rf` of the root after the same name checks `removeProfileDataDir` applies.

### Adopting main-v3 (decision D11)

Once versions exist, adding `main-v3` is one **Add version** in the UI. The manager side that
makes a `main-v3` deployment work is the contract handling above plus two things:

- The generated secrets reach the containers through `.env.<profile>`: `API_AUTH_TOKEN` at the
  root, `SRS_WEBHOOK_TOKEN` too (the root env wins over the engine env in `deploy.sh`, and the
  entrypoint reads it from the compose environment).
- The manager's own calls to the uploader stay on `/health`, which is outside the token gate.

The chequebook feature reads `CHEQUEBOOK_MIN_BZZ` from the contract as the floor to display for
that deployment, falling back to the manager's own floor.

## API

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/versions` | | `[{ id, name, gitRef, commitSha, status, isDefault, builtAt, contract, tested, deployments }]` |
| POST | `/versions` | `{ name, ref }` | SSE build log, then `version.changed` |
| POST | `/versions/:id/update` | | SSE build log |
| POST | `/versions/:id/default` | | 204, 409 while the version is not marked tested |
| PATCH | `/versions/:id` | `{ tested }` | 200, 400 for `{ tested: true }` while the version is not Ready |
| DELETE | `/versions/:id` | | 204, 409 with deployment names |
| POST | `/profiles/:name/move-version` | `{ version_id }` | 202, the profile |
| POST | `/groups/:id/move-version` | `{ version_id }` | 202, the members |

`POST /profiles` and `POST /groups` accept `stack_version_id`, default to the default version.

## Frontend

- `versions/VersionsPage.tsx`, `versions/AddVersionForm.tsx`, `versions/versionsApi.ts`, route and
  nav item. The build log streams into a `LogPane` the deploy actions can reuse later.
- Wizard `BasicsStep` gets the select from `wizardState.versionId`. `wizardSubmit` sends it.
- `AtAGlanceCard`, `DeploymentRow` chip, `DeploymentsPage` filter, `DeploymentHeader` menu item
  and `MoveVersionDialog.tsx`.
- Store: `versions` loaded with the profiles, refreshed on `version.changed`.
- Mock manager: two versions seeded (`bundled` and `main-v3`), add and update simulate a build
  with a log that takes a few seconds, move takes a deploy.

## PR split

1. **Versions table, bundled row, per version paths, Versions page, add and update with the
   build script, contract reader.** Deployments keep running the bundled version. Nothing on
   the host changes except the new bind mount and `git` in the api image.
2. **Per deployment version: wizard select, move, list chip, contract driven ports and slot cap,
   per version image tags** (needs the upstream `build_compose_files` change, D9, landed and the
   submodule pin moved).
3. **main-v3 support: generated secrets, engine defaults per version, chequebook floor from the
   contract, the Tested toggle.** Ends with one real `main-v3` stream on the host, Levi's gate.

## Tests

- `stackContract` against fixture copies of `_lib.sh`, `deploy.sh`, `.env.sample` and the
  entrypoints from both branches: nine ports for v2, ten plus the second band for v3, caps 999
  and 99, secrets none and two, defaults 1.5 and 0.5.
- `stackPaths` for the bundled root and a versions root. Slot cap refusal. Move refused while
  transitional, when not ready, when the slot exceeds the cap. Image tag naming from name and
  sha. The build mutex.
- Integration (laptop, Docker running): add a version from a local file URL of the submodule
  (`git clone` accepts a path), watch it build, create a deployment on it.
- Browser pane against the mock: add, update, default, remove refused, wizard select, move, the
  behind count.

## Done means

- The Versions page lists the bundled version and any added one with its contract in plain
  words, and adding a branch builds it with a live log.
- A deployment can be created on a chosen version and moved to another, the Bee node keeping its
  identity and funds across the move.
- Ports, slot cap and required secrets come from the version, not from a hardcoded table, and a
  `main-v3` stream deploys with its two generated secrets and streams end to end.
- Two versions never overwrite each other's images once the upstream compose hook is in.
- Docs: `README.md` layout section and `manager/README.md` describe versions. The submodule
  stays as the bundled default.
- Typecheck, build, tests green. `git` is the only addition to the api image. No em-dashes or
  semicolons in copy.
