# T02. Isolate every SRS validation request

Source: R02 (P2 after the debate: the watch is not a guaranteed control and a poisoned directory needs repair). Depends on: nothing. Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

Every SRS check writes the same `srs.conf.check` (engineConfigCheck.ts:40, :106 to :132), bind-mounts it with `-v`, and removes it in `finally`. Two concurrent checks validate each other's bytes, and a race leaves a directory at that name, after which every check fails with EISDIR.

## Scope

- One temporary directory per check under the deployment's engine directory, removed with everything in it on every exit path: failure during writing, spawning, parser failure, timeout, cancellation.
- `--mount type=bind,readonly` in place of `-v`.
- File creation happens inside the protected cleanup lifecycle. Cleanup owns only that request's directory and never removes the whole engine directory recursively.
- An old `srs.conf.check` directory left by the previous scheme must not block the new one.
- Passing validation does not bypass the deployment reservation. Only the winning revision is stored.

## Acceptance

- Concurrent valid and invalid requests for one deployment each validate their own bytes. The invalid one is refused.
- The write, mount and cleanup race is driven with controlled barriers in the fake command runner, not inferred from luck. One request's cleanup cannot remove another's input.
- A source that disappears fails the check rather than becoming a directory.
- After one hundred interleaved checks the engine directory holds no leftover file or directory.
- A real SRS parser check confirms distinct directives (T20's Docker job).

## Where the design lives

PRD "**T02.**" in Fable round 1 section 5, OpenAI round 2 section 4, and the T02 line of "Question 8" in Fable round 2.

## Code anchors

manager/src/domain/engineConfig/engineConfigCheck.ts, its unit test, dataDirs.ts `engineConfigDirFor`.
