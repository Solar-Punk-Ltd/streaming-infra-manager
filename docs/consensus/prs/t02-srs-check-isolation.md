# fix: give every SRS check a directory of its own (T02)

Branch `fix/t02-srs-check-isolation`, two commits on top of main-v2 at d046ebf. Not pushed. Row T02 of the consensus set, see `../issues/t02-srs-check-isolation.md`. Independent of the T01a branch.

## What was wrong

Every SRS validation wrote the same `srs.conf.check` in the deployment's engine directory and mounted it with `-v`. Two checks in flight read each other's copy, so a valid save could be judged on the other request's bytes. One check's cleanup removed the other's file. A copy gone before the container started had Docker create a directory under that name, after which every later check failed with EISDIR until someone removed the directory by hand.

## What changed

- Each check writes its copy into a directory of its own, `check-<random>/srs.conf`, created with `mkdtemp` under the engine directory. The write happens inside the cleanup's protection.
- The copy is mounted with `--mount type=bind,source=...,target=/check/srs.conf,readonly`. Unlike `-v`, `--mount` refuses a source that does not exist instead of creating a directory in its place.
- Cleanup removes only that check's directory, on success, refusal, a failing runner and a vanished copy. The engine directory itself and anything else in it are never touched.
- A `srs.conf.check` directory the old scheme left on a host is not in the way. It is left alone. The deploy-time prune removes only names matching the engine's config-file pattern, so per-check directories are never pruned either.

## Commits

1. `1977d35` (as cherry-picked) test: the SRS check with two files in flight, a failing run, a vanished copy and an old check directory. Six fail on purpose.
2. `2fe01bb` (as cherry-picked) fix: give every SRS check a directory of its own, mounted read-only with --mount.

The commit ids on the branch differ from these two after the cherry-pick. `git log fix/t02-srs-check-isolation` shows the current ones.

## Test evidence

| # | Guarantee | Test (engineConfigCheck.test.ts) | On the test commit | On the fix commit |
| --- | --- | --- | --- | --- |
| 1 | The container runs on a `--mount type=bind` of `check-*/srs.conf`, read-only, and the directory is gone afterwards while the engine directory remains | "runs srs -t in a throwaway container of the version image on a filled copy" | fail, no `--mount` | pass |
| 2 | Two checks held at a gate until both copies exist each read their own bytes, only the refused one is refused, nothing is left | "gives two checks in flight a copy each, and refuses only the refused one" | fail, one copy for both | pass |
| 3 | A runner that throws leaves no directory and the failure is passed through | "removes its copy when the runner fails, and lets the failure through" | fail | pass |
| 4 | A copy removed before the container starts yields a failure answer and creates nothing | "fails, and creates nothing, when its copy is gone by the time the container starts" | fail | pass |
| 5 | An old `srs.conf.check` directory does not block a check and is left alone | "works beside a srs.conf.check directory the old scheme left behind" | fail, EISDIR | pass |
| 6 | A hundred interleaved checks each answer for their own file and leave nothing behind | "leaves nothing behind after a hundred interleaved checks" | fail | pass |

Commands, in `manager/` after `pnpm --filter @streaming-infra-manager/common build`:

```
pnpm exec tsx --conditions=development --test test/unit/engineConfigCheck.test.ts
```
18 tests. 12 pass and 6 fail on the test commit, 18 pass on the fix commit.

```
pnpm test
```
499 tests, all pass.

```
pnpm typecheck
```
Clean.

## Review

Reviewed by the TypeScript reviewer agent on 2026-09-08 against the two commits: no critical or high findings, two medium, two low. Taken:

- `58ded98` test: the gate test's 200 ms fallback was a required member of the wait, so every run spent 200 ms. It is now a valve that is raced and cleared, and the comment says what it is for.
- `1ab3e72` test: the hundred-checks test asserted a count of refusals, which a swapped pair of files could satisfy. Every answer is now held to its own file.

Not changed: a comma in a profile name would break the `--mount` option, the same way a colon broke `-v`. Profile names are restricted to lowercase letters, digits and dashes by the name rule, so none can reach it.

## Still to do under T02, outside this change

A real `srs -t` run on two distinct directives belongs to the Docker-backed job T20 introduces. Nothing here touches the host.
