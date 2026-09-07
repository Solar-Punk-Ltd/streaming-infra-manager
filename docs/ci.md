# Checks

Two workflows under `.github/workflows`. Neither reaches a host, a Bee node or funds. A green check says nothing about those.

## checks, on every pull request and push to main-v2

What runs, in order: install from the frozen lockfile, build common, type checks in every package with the test files included, the unit suites of common, manager and frontend, the frontend build.

What it proves: the code compiles, the unit-level guarantees hold, the frontend bundles.

What it does not prove: anything that needs Docker, Postgres, a Bee node, a host or money. The manager's tests get a `DATABASE_URL` that names nothing, because the config module requires the variable at load and the tests never open a database.

This is the check main-v2 requires before a merge, decision D06 of 2026-09-07. Turning the requirement on is a repository setting Levi makes after the workflow has run once, and he keeps a bypass. Agents never push.

## docker-backed checks, by hand

`workflow_dispatch` only. It starts Postgres beside the runner, builds the manager and starts it with the bundled stack from the submodule, creates the user the suite signs in as from the repository secret `ITEST_PASSWORD` through the CLI's stdin, and runs the integration suite signed in against that manager with `MANAGER_TEST_TARGET` declared. Real containers are built and started on the runner and nowhere else. Nothing is paid for.

Secrets Levi sets: `ITEST_PASSWORD`, the password of the user the suite signs in as. The workflow refuses to start without it and never prints it.

Skips are visible: a missing secret fails the first step in words, and the suite's own preflight refuses a target that is not declared. A green run here proves the deployment lifecycle on a runner. It proves nothing about the host or a funded node.

Not run yet: this workflow was written without a runner to try it on. Its first run is the check of the workflow itself, and paths or timings may need a fix.

Not covered yet: the container-backed regressions the review named, an engine that fails to start on a config file, `srs -t` on distinct directives, the pinned OvenMediaEngine pair and the shared image tag harness. They join this workflow as those rows land.

## Pinning

Actions are pinned by commit, with the tag in a comment. pnpm comes from the `packageManager` field. When a pin moves, the new tag's age and its commit are checked the way a dependency bump is: a release under two weeks old is a flag, and the newest release is the riskiest choice.
