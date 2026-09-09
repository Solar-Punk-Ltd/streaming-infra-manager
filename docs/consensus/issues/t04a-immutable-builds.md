# T04a. Immutable per-build directories and an identified running build

Source: R03. Priority: P1. Depends on: nothing. Decision: D08 decided (no catalogue, the previous build is retained for recovery). Size: M, upper end.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`stack-version-build.sh` moves the checkout to the new commit before the build (:80 to :96), builds in place (:105) and rsyncs (:121), so a failed update leaves a mixed tree, a deploy admitted during the update consumes it, and a container restart picks up new files under an old container. `versionFor` accepts building or failed for existing deployments (DeploymentOrchestrator.ts:158) and falls back with a warning.

## Accepted design, in short

- Layout: `<versions>/<name>.repo/` (the clone, never deployed from) and `<versions>/<name>.builds/<id>/`, one immutable tree per build with `.stack-manifest.json` (commit, build id, built at, toolchain) and a `.complete` marker written last. Dots cannot appear in version names, so the legacy root `<versions>/<name>/` is never an ancestor of a build. `stack_versions.layout` is legacy or builds. The row carries `commit_sha` and `build_id`. Publication is one row update under `FOR UPDATE`. Migration moves `.git` to `<name>.repo/.git` and touches nothing else.
- Captured descriptor: the deploy claim records the build it will run (build id, commit, contract hash) in the DEPLOYING transaction under `SELECT ... FOR SHARE` on the version row, and `startReservedJob` reads the descriptor from the reservation. The reread at :410 goes.
- `build_references(version_id, build_id, holder_kind, holder_id, services, created_at, resolved_at)` with holder kinds job, snapshot, operation, version-current, version-previous. The claim inserts a job reference. The success hook reconciles from observation: it inspects each container, reads which build it mounts, writes one snapshot reference per service, and resolves job references fully covered by newer observations. Failure, snapshot failure and a crash leave the job reference unresolved. Boot runs the same observation. A later claim adds its own reference and never modifies an older one.
- Prune takes `FOR UPDATE`, protects every unresolved job reference, every snapshot reference, every open engine config operation's build, and the current and previous roles, then deletes the rest.
- Same commit built again: reuse the complete build and say so. A forced rebuild is explicit and gets `<commit>-r<n>`. Files under a published path are never replaced.
- A builds row whose artifact or `.complete` is missing refuses every deploy naming the missing artifact. The flat fallback exists only for a legacy row.
- Per-attempt staging `<name>.builds/tmp-<attempt>` with the build container named `stack-build-<attempt>`. Boot marks the attempt interrupted and deletes the directory only when no container of that name exists.
- Host-owned inputs (`.env`, `deploy/config.json`, `engines/*/.env`): the supported editing path is `deploy/scripts/stack-config-edit.sh`, which takes `flock` on `<root>/.config.lock`, replaces each file atomically and writes `.config-revision.json` (generation and the hash of every file) last by rename. Capture takes the same lock with a bounded wait, reads each file between two stats with bounded retries, format-checks it (base env holds every key of `.env.sample`, `config.json` parses, engine envs parse), compares every hash to the manifest, refuses publication naming the file on any mismatch, and stores the captured bytes and generation with the job or build. Hashes come from those bytes. A root without a manifest gets generation 1 from its current bytes at first boot. Every manager-side writer of a host-owned or per-profile file becomes write-then-rename (envUtils.ts:399). The per-profile runtime set inside a build is `.env.<profile>`, `engines/<engine>/.env.<profile>`, `deploy/.env.deploy.<profile>`.
- Truthful state: per-service `build_commit` on container snapshots, `last_full_deploy_commit` on the profile, one commit shown when every service agrees and "mixed" with the list otherwise, observed image identity per service as diagnosis.
- A failed update leaves the row ready at the old commit with `last_error` and the attempt time. `failed` is reserved for a version with no usable build. A deploy for a version whose row is gone is refused naming the version, never run on the bundled checkout.
- A new manifest reader with its own tests. The parent-directory helper at bundledCommit.ts:43 to :53 is not relied on.

## Acceptance

- Force a build failure, a failure partway through publication, a restart before database finalization, an Update racing deploy admission in both orders, an engine-only restart after an update, and a refused deploy on a missing or unverified version. Each retains a verified old tree, exposes a verified new tree, or refuses with recovery information. No mixed tree is ever marked usable.
- Pause a deploy after selection and race reference acquisition against prune: it never launches from a deleted path.
- A container mounted from B, an old snapshot naming A, an unresolved job reference to B, then C and D published, D admitted, prune run before any removal: B stays protected. An engine-only snapshot leaves the uploader's reference in place.
- Repeat an Update for a published commit with different candidate bytes: reuse unchanged or a distinct identity, never files replaced under a published path.
- A builds row pointing at an absent B with a valid flat root present: refused, naming B.
- The legacy root is never scheduled by prune while it is an ancestor of anything.
- Manager death with a live builder: its staging directory survives, a new attempt uses a different path.
- A truncated intermediate base file makes capture refuse. A two-file edit paused after the first replacement yields all A, all B or a bounded refusal, never B/A, and a complete B is captured after the edit resumes.
- A no-op or partial deploy does not advance untouched services to the new build.

## Where the design lives

PRD "**Question 4, T04's publication and admission**" (Fable round 2), "##### Question 1. T04 immutable directories and the database reference" (OpenAI round 3), "##### Question 1, T04" (Fable round 3), "##### Question 1. T04a and T04b" (OpenAI round 4), "##### Question 1, T04a" (Fable rounds 4 and 5), "##### Question 1. T04a references and the six capture rules" (OpenAI round 5), "##### Question 1. T04a committed-revision capture" (OpenAI round 6).

## Code anchors

manager/scripts/stack-version-build.sh, versions/StackVersionService.ts, versions/PostgresStackVersionRepository.ts (markBuilt :104 to :123, setCommitSha :151), versions/stackPaths.ts, versions/bundledCommit.ts, DeploymentOrchestrator.ts (versionFor :158, reserveDeploy :249 to :269, runReserved :289, startReservedJob :395 to :463, snapshot warning :701), utils/envUtils.ts:399, ScriptRunner.ts:67.
