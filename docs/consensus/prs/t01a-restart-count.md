# fix: read Docker's restart count from where Docker answers it (T01a)

Branch `fix/t01a-restart-count`, four commits on top of main-v2 at d046ebf. Not pushed. Row T01a of the consensus set, see `../issues/t01a-restart-count.md`.

## What was wrong

`ContainerControl.inspect` read `RestartCount` from under `State`. Docker answers it beside `State`, at the top level of the inspect answer. Every container therefore read as never restarted, and the watch after a config-file apply could not see an engine that died on the file and was brought back by its restart policy between two polls. The test double mirrored the same wrong shape, so the adapter and the double agreed with each other and not with Docker. Found in OpenAI's review, confirmed locally with a read-only `docker inspect`.

## What changed

- `InspectedContainer` is picked out of dockerode's own `ContainerInspectInfo`, so the shape is Docker's by construction and a double that puts the count under `State` no longer compiles.
- The adapter reads `info.RestartCount`.
- The fake daemon answers the real shape. It gains `inspectAnswer`, a verbatim answer passed through untouched, and one recorded answer, `RUNNING_AFTER_TWO_RESTARTS`.

## Commits

1. `f3e03fe` test: the inspect adapter and the watch, fed a restart count the way Docker shapes it. Fails on purpose.
2. `73b67ae` fix: read the restart count from where Docker answers it, beside State. Makes them pass.
3. `8764aae` refactor: read StartedAt as Docker's shape gives it, without a fallback that cannot fire.
4. `115b194` test: freeze the recorded inspect answer the two suites share.

## Review

Reviewed by the TypeScript reviewer agent on 2026-09-08 against commits 1 and 2: approved, no critical or high findings, three low notes. Two are taken in commits 3 and 4. The third, that the adapter now trusts dockerode's non-optional `RestartCount` with no fallback to zero, is kept as it is on purpose: the shape is Docker's by construction, and a fallback would hide a daemon that did not answer the field behind a count of zero, which is the blindness this change removes.

## Test evidence

| # | Guarantee | Test | On f3e03fe | On 73b67ae |
| --- | --- | --- | --- | --- |
| 1 | Top-level `RestartCount: 2` maps to `restartCount: 2` | containerControl.test.ts, "reads the restart count from beside State, where Docker puts it" | fail, actual 0 | pass |
| 2 | No container of that service answers null | containerControl.test.ts, "answers null when the deployment has no container of that service" | pass, existing behaviour | pass |
| 3 | Through the real adapter, the watch sees the restarts and puts the previous file back | engineConfigService.test.ts, "sees a container that restarted on the new file and puts the previous one back" | fail, the new file stayed and no reason was recorded | pass |

Commands, run in `manager/` after `pnpm --filter @streaming-infra-manager/common build`:

```
pnpm exec tsx --conditions=development --test test/unit/containerControl.test.ts test/unit/engineConfigService.test.ts
```
37 tests, 37 pass on the fix commit (35 pass and 2 fail on the test commit).

```
pnpm test
```
494 tests in 119 files, all pass.

```
pnpm typecheck
```
Clean on both commits.

## Not in this change

T01's ownership redesign (persisted operation, intent revision, boot verification) follows on its own branch. Nothing here touches the host or any deployment.
