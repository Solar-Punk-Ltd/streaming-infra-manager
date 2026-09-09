# T01a. Read Docker's restart count from where Docker puts it

Source: R01 (adapter evidence found in OpenAI round 3). Priority: P1. Depends on: nothing. Decision: none. Size: S. Ready first. Ships before T01.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`ContainerControl.inspect` reads `info.State.RestartCount ?? 0` (manager/src/domain/ContainerControl.ts:228), and the `InspectedContainer` interface (:101 to :109) declares the count under `State`. Docker's inspect answer carries `RestartCount` beside `State`, at the top level (dockerode `ContainerInspectInfo`, Moby `types.go`). The test double mirrors the wrong shape (manager/test/support/fakeDocker.ts:121 to :129), so the pair agrees with itself and disagrees with Docker. A container that restarted and is running again between two polls reads as running with zero restarts, and the config-file watch never reverts.

Confirmed locally on 2026-09-07 with a read-only `docker inspect` of an unrelated container: `RestartCount` is top level, `State` has none.

## Scope

- Read `RestartCount` from the top level of the inspect answer. Keep `State.Status` and `State.StartedAt`.
- Mirror the real shape in the test double, and tie the adapter's interface to dockerode's own `ContainerInspectInfo` so the shape cannot drift again.
- Add the regression OpenAI specified.

## Acceptance

- A recorded inspect answer with top-level `RestartCount: 2` and `State.Status: "running"`, passed through the real adapter, yields restart count 2.
- The same answer, through the real adapter and then through the watch in `EngineConfigService`, takes the revert path: the previous file is stored again and the engine is recreated on it.
- The existing service test supplies an already normalised count and does not verify the mapping, so it stays and the new test is added beside it.

## Where the design lives

PRD "##### Question 2, T01" (Fable round 3, last bullet) and "##### Question 2. T01 and T01a" (OpenAI round 4).
