# ci: repeatable checks and the merge gate's workflow (T20)

Branch `fix/t20-ci-checks`, on top of `fix/t10-integration-client` (a real dependency: the Docker-backed run uses the signed-in client), plus the two shared frontend runner commits, then three commits of its own. Not pushed. Row T20 of the consensus set, see `../issues/t20-ci-and-merge-gate.md`. Decision D06 applied: the workflow exists, the requirement is Levi's setting.

## What changed

- `.github/workflows/checks.yml`: on every pull request and push to main-v2, install from the frozen lockfile, build common, type checks in every package with tests included, the three unit suites, the frontend build. The manager's tests get a `DATABASE_URL` that names nothing.
- `.github/workflows/docker-checks.yml`: by hand only. Postgres beside the runner, the manager built and started with the bundled stack from the submodule, the suite's user created from the repository secret `ITEST_PASSWORD` through the CLI's stdin (node hands it over from the step's environment, no shell writes it), the integration suite run signed in with the target declared. A missing secret fails the first step in words.
- `docs/ci.md`: what each proves and does not, the secret Levi sets, the pinning rule, what is not covered yet.

## Pins

Actions are pinned by commit with the tag in a comment: actions/checkout v7.0.1 (released 2026-07-20), actions/setup-node v7.0.0 (2026-07-14), pnpm/action-setup v6.0.10 (2026-08-03). pnpm/action-setup's newest release, v6.1.0, is three days old at the time of writing and was passed over for that reason. pnpm itself comes from the `packageManager` field.

## Commits

1. `280cec7` ci: type checks, the unit suites and the frontend build on every change to main-v2
2. `c9df080` ci: a Docker-backed run of the integration suite, by hand, against a manager on the runner
3. `1eb7cdd` docs: what the checks prove and what they do not, and who sets the requirement

## Evidence

Both workflow files parse as YAML. The steps of the checks workflow are the commands run by hand on every branch of this set. Neither workflow has run on a runner: there is no push in this session. The first run of each is the check of the workflow itself, and the Docker-backed one in particular may need paths or timings fixed.

## For Levi

- Push the branch and let `checks` run once, then make it required on main-v2 with your bypass, D06.
- Set the repository secret `ITEST_PASSWORD` before the first manual Docker-backed run. The secret guard on this machine refused to write the workflow while it piped the variable through a shell command, which is why node hands the password over instead.
- Merge T10 first. This branch sits on it.
