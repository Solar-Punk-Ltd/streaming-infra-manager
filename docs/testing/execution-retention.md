# Execution-root retention after partial deploys

Status: verified on 2026-09-19 at `e88581a42483e8caf7fa6a3ca41b5492a8b74f1e`.

Date: 2026-09-19. Baseline: `a5b4253`.

## Guarantee

A launched execution root is removed only when a complete local Docker observation finds no container dependency on it and the database still proves that its job finished, its deployment moved on and no launcher for the same project remains unresolved. Unknown evidence retains the root. Remote-target roots are retained because their rsynced paths are in another filesystem namespace.

## TDD evidence

The regression was written before production changes. The focused RED command was:

```text
bash /Users/kisslevente/Documents/git/estate/tools/lane.sh --name infra-retention -- env DATABASE_URL=postgres://unused@localhost/unused BEE_LOCAL_HOST=127.0.0.1 SHLS_ROOT=/private/tmp/infra-retention-stack ./manager/node_modules/.bin/tsx --conditions=development --test manager/test/unit/executionRetirementMounts.test.ts
```

RED ran three cases. Two failed for the intended defect. An uploader-only success and an unavailable observation both changed the previous root from `launch-uncertain` to `released`. The moved-mount control passed.

A follow-up review found that the first manager-mount exception also ignored a foreign parent bind. The same single-file command then ran eight cases and failed only the new foreign-parent regression, releasing the old root instead of retaining it. The exception was narrowed to the manager API's exact administrative shape before the final green run.

The focused GREEN command covered retention, restart recovery, the production local reader, deploy copies and both existing mount helper suites:

```text
bash /Users/kisslevente/Documents/git/estate/tools/lane.sh --name infra-retention -- env DATABASE_URL=postgres://unused@localhost/unused BEE_LOCAL_HOST=127.0.0.1 SHLS_ROOT=/private/tmp/infra-retention-stack ./manager/node_modules/.bin/tsx --conditions=development --test manager/test/unit/executionRetirementMounts.test.ts manager/test/unit/executionBootRecovery.test.ts manager/test/unit/containerControl.test.ts manager/test/unit/deployExecutionCopy.test.ts manager/test/unit/executionMountAttribution.test.ts manager/test/unit/executionMountCapture.test.ts
```

GREEN passed 92 tests in 17 suites with no failures, skips or cancellations. The cases cover a full SRS and uploader execution, a successful uploader-only replacement that retains the engine's root, later failed launches, unavailable and malformed observation, unregistered execution mounts, interrupted `deleting` recovery, the manager API's administrative versions-root and host-root mounts, a foreign parent bind, and cleanup after all deployment mounts move.

The PostgreSQL regressions prove that an open or blocked deploy attempt prevents the claim, a new launcher waits on the daemon advisory lock while cleanup claims a root, and cleanup acquires that lock before the profile row to match engine configuration admission. The last regression failed with PostgreSQL `55P03` before the lock-order correction in [run 35440776388](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35440776388).

[Run 35440997869](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35440997869) passed all 547 PostgreSQL tests across 36 suites, including these regressions. The same commit passed build, typechecks, 3,422 unit tests, seven native transport tests and 261 browser-suite tests. All 4,237 tests passed with zero skips. PostgreSQL ran in the PR workflow's disposable databases because the shared verification mapping does not provision this repository's nine task databases. No live host behavior was tested.
