# Brief: every deployment runs from its own private copy, 2026-09-11

Status: done, merged on `feat/ai-remediation` on 2026-09-11. The last engineering slice of the main-v2 remediation roadmap. Branch `feat/ai-remediation`. Tests first, one logical change per commit, `test:` then `feat:`/`fix:`. No em-dashes or semicolons in prose, comments, docs, log lines or commit messages. Never touch the host, never run `deploy/deploy.sh`, never push without Levi's word for a remote that is not his own.

Line numbers in this brief were re-read at `007260f` on 2026-09-11. The earlier map in the session memory (`exact-execution-map.md`) was read at `3f7a265` and its line numbers have moved.

## Levi's decision this brief implements

D11 (2026-09-09, "A: nice ok as recommended", reaffirmed 2026-09-11): one private execution copy per deployment, replaced on the next successful deploy, the previous copy kept until the new deploy is healthy.

## What is true today

A deployment runs the stack's scripts with the working directory set to the version's **build** directory, and writes into it. `DeploymentOrchestrator.prepareReservedJob` (manager/src/domain/DeploymentOrchestrator.ts:740) takes `stackPathsForRoot(build.root)` from the descriptor the claim captured, and every verb that follows uses those paths: `ensureStackDefaults` at :746 and again inside `runJob` at :993 copies `.env.sample` to `.env` and `deploy/config.sample.json` to `deploy/config.json` there, `writeProfileEnv` at :753 writes `.env.<profile>` there, and the stack's own scripts add `engines/<engine>/.env.<profile>` and `deploy/.env.deploy.<profile>` under the same root. `runJob` spawns with `cwd: cfg.paths.root` at :1046, and the stack's `_lib.sh` derives its own `ROOT_DIR` from the script path, so both agree on the build directory.

Three things follow, and all three are why this slice exists.

1. **A build stops being the artifact it was verified as.** Migration 015 calls a build "one immutable directory per build". `verifyBundledArtifact` and every tree digest taken at publication stop holding the moment the first deploy runs from it. Nothing can later prove which bytes a deployment actually ran.
2. **Two deployments on one build share one mutable tree.** They bootstrap the same `.env` and `deploy/config.json`, and each leaves its own `.env.<profile>` beside the other's.
3. **Recovery cannot name the tree a launched job ran from**, because the tree is shared and has been written to since.

What already exists for the fix, built by Codex under T04b and never called by anything: migration 025 `execution_roots` (one row per job reference, states `registered`, `copying`, `ready`, `launch-uncertain`, `deleting`, `released`, and the `execution` holder kind on `build_references`), `PostgresExecutionRootRepository` (register, beginCopy, markReady, claimLaunch, claimUnstartedCleanup, completeCleanup, find, listUnreleased), `copyExecutionRoot` in `executionRootFiles.ts` (an exact private copy under `<parent>/<executionId>/tree` with `owner.json` and `ready.json` beside it, directories 0700, the source digest verified before, during and after), and the read-only observation helpers `captureExecutionMounts` and `observeExecutionMounts`. Three production guards already read the table and can never fire because nothing inserts a row: `buildJobClaim.ts:156` refuses to cancel a job whose execution may have launched, `PostgresStackVersionRepository.ts` refuses a version removal, and `PostgresEngineConfigOperationRepository.ts` refuses a config operation.

## The design

**1. Where copies live.** `executionsRootFor(versionsRoot)` is `<STACK_VERSIONS_ROOT>/.executions`, a sibling of every version's directory, added to `stackPaths.ts` next to `managerUpgradeGuardRootFor`. A version name cannot contain a dot (migration 010), so the name cannot collide, and `cleanInterruptedAttempts` only walks `*.builds` so the boot scan ignores it. It has to be under the versions root rather than anywhere else because that root is bind-mounted into the api container at the same absolute path it has on the host, which is what lets a compose file inside a copy resolve its own relative volumes. The directory is created 0700 at boot.

**2. The deploy makes the copy before anything runs.** In `prepareReservedJob`, between the port reservation and the first write the scripts consume, the deploy registers an execution root against the job reference it already holds, copies the build into it, and takes its paths from the copy instead of `build.root`:

- the source identity is the captured descriptor: version id, build id, the commit read from the build's own `.stack-manifest.json`, the build root, and the tree digest of the build as it stands now
- `register` writes the `execution_roots` row and an `execution` holder on `build_references` in one transaction, under `lockOwnership`, which re-checks the version row, the profile (instance, intent, status, version, `deploy_job_reference_id`, target alias), the unresolved `job` reference with the same services, and the verified daemon
- `beginCopy` takes an exclusive copy token, `copyExecutionRoot` writes the copy, `markReady` records it
- `ensureStackDefaults` and `writeProfileEnv` then write into the copy, and `runJob` spawns with the copy as the working directory

A version whose layout is not `builds` (a legacy flat tree, which is mutable by definition) keeps today's behaviour and gets no copy. `lockOwnership` refuses those rows already. So does a reservation with no services, which completes without running a script.

**3. Launch is persisted before the spawn.** `runJob` gains a `beforeLaunch` step that runs immediately before `cfg.onLaunch?.()` and the spawn. It moves the row `ready` to `launch-uncertain`. If it cannot, nothing is spawned. From that moment the copy is one a process may have run from, `cancelBuildJob` refuses to cancel the job (`buildJobClaim.ts:156`, live for the first time), and only supersession retires the copy.

**4. Stop, health and remove run from the same copy.** `pathsFor(profile)` resolves the version row, which is the wrong tree once a deployment runs from a copy: the compose files, the scripts and the deployment's own `.env.<profile>` are all in the copy now. Each of `startStop`, `startHealth` and `startRemove` asks for the deployment's current copy first and falls back to the version root when there is none. The current copy is the newest `launch-uncertain` row for that profile name and instance id. These verbs register no row of their own: `lockOwnership` requires the profile's live `deploy_job_reference_id`, which only a deploy holds.

**5. Retention, which is D11.** A deployment keeps its current copy and at most one previous.

- When a deploy **succeeds**, after RUNNING is committed and its containers are recorded, every copy of that deployment older than the new one is retired.
- When a deploy **launches**, every copy older than the one previous is retired, so repeated failures cannot grow the disk. A failed deploy therefore leaves the last copy that worked in place, which is the point of keeping a previous one.
- Retiring means `claimSupersededCleanup` (a new repository method: `launch-uncertain` to `deleting`, only for a row whose own job reference is resolved and whose profile now owns a newer launched copy), then `removeExecutionRoot` on disk, then `completeCleanup`, which resolves the `execution` hold so the build can be pruned.
- A copy that never launched is retired through the existing `claimUnstartedCleanup`, inline when the deploy fails before the spawn and at boot for what a gone manager left.
- Anything uncertain keeps the copy and keeps the hold. A cleanup that throws is logged and the deploy is not failed for it.

Steady state is one copy per deployment, two while a deploy is in flight, three transiently. At about 16 MB each that is what Levi approved.

**6. Boot.** Before the orchestrator judges attempts, a sweep over `listUnreleased()`: `registered` and `ready` rows are retired (nothing can have run from them, and no copy is in progress at boot), `copying` rows are retired through a new `claimInterruptedCopyCleanup` for the same reason, `deleting` rows finish their cleanup, and `launch-uncertain` rows are left exactly as they are. This mirrors `cleanInterruptedAttempts` and `failInterruptedBuilds`, which already assume one manager at boot.

## The two open design points, settled

**0700 directories against the uids the engine containers run as.** Keep 0700. Checked on the stack's main-v3 on 2026-09-09 and unchanged: no running container bind-mounts anything from the stack tree. The engines mount only the operator's config file from the data root through the compose overlays, and bee mounts its data directory, both of them absolute paths under `BEE_DATA_ROOT` that the manager writes. The copy is the compose working directory, the env files and the scripts, all of them read by the manager's own process and by the docker CLI it runs as itself, never by the daemon or by a container. A copy readable only by the manager is therefore strictly better than the world-readable build tree it replaces, and the bee-uid-999 problem the map warned about does not arise. If a future stack version bind-mounts part of its own tree, this is the line that has to change, and the mount observation helper is what would find it.

**How many copies to keep.** Answered by D11 above and implemented in section 5.

## What is deliberately not in this slice

Named so Levi can rule on them rather than find them missing. None of them is required for a deployment to stop writing into its build.

- **T01's atomic begin and revert wiring, creator receipts and operation-hold release.** The repository APIs exist and are inactive. They are a separate slice with their own review, and they depend on this one rather than the other way round.
- **The full-daemon mount observation as the retirement authority.** `observeExecutionMounts` attributes a container to a copy by its compose working directory. That works only for a local target: `deploy.sh` rsyncs the tree to a remote base before running compose there, so a remote container's working directory is never one of our paths. Retirement here is authorised by the replacing deploy's own success and by the job reference being resolved, which holds for both target kinds. The helper stays where it is for T01's attribution work.
- **Builds that were deployed from before this change** carry the `.env`, `.env.<profile>` and `deploy/config.json` files those deploys left. The first copy made from such a build copies them too, because the copy is verified byte for byte against its source. They are inert, the copy is 0700, and no new writes reach a build after this slice. Worth one line in the handover, not worth a migration.

## What must keep holding

- No deploy, stop, health or remove writes into a build directory again. A test asserts the build tree is unchanged across a deploy, which is the assertion the map found missing everywhere.
- A deploy that cannot make its copy fails before anything is spawned, and cancels its job.
- A copy is never deleted while the job that launched from it is unresolved.
- Removal of a copy never touches a path outside `<versions>/.executions/<uuid>`, and the path is checked against the record before the removal.
- An orchestrator wired without the execution service behaves exactly as it does today. Every existing unit test that does not wire it stays green unchanged.
- Secrets stay out of logs. Copy log lines name the execution id, the profile and the build id, never a file's contents.

## Tests to write first

1. **Unit, files.** `removeExecutionRoot` removes the owner root and refuses a record whose root is not the configured UUID path, a record whose `owner.json` names another execution, and any path outside the parent.
2. **Unit, retention.** The pure policy function: which copies a deployment retires on launch and on success, that the current and the one previous are kept, that a copy whose job is unresolved is never chosen, and that an empty list is handled.
3. **Unit, orchestrator.** A deploy with an execution service wired runs with the copy as its working directory (`FakeScriptRunner` records `options.cwd`), writes its `.env.<profile>` into the copy, leaves the build tree byte for byte unchanged, marks the row `launch-uncertain` before the spawn, and retires the copy without spawning when the copy fails. An orchestrator with no execution service runs from the build exactly as before.
4. **Unit, the other verbs.** Stop, health and remove of a deployment with a current copy run from the copy, and from the version root when it has none.
5. **Database.** `claimSupersededCleanup` refuses a row whose job is unresolved, refuses when no newer launched copy exists, and succeeds when both hold. `completeCleanup` resolves the `execution` hold so `pruneBuilds` can then remove the build. The boot sweep retires `registered`, `ready` and `copying` and leaves `launch-uncertain`. `cancelBuildJob` refuses once a row is `launch-uncertain`, which is the guard that could never fire before.
6. **Mutation checks.** Removing the copy step must fail test 3. Removing the `launch-uncertain` transition must fail the cancel test in 5.

## Definition of done, and what it came to

The manager unit suite and the database suite green, `pnpm test` green, the three CI jobs green on the pushed head, a handover section in `docs/handover/main-v2-remediation.md` with the dated result, and this brief updated to done.

All of it. Manager unit 2354 cases, the whole database directory 524 against nine disposable databases, the shared package 321, the frontend unit suites 100, the native transport suites 7, none skipped, every typecheck clean. The result and the two defects the proving turned up are in the handover's own section.
