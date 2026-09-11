# T10. Repair the authenticated integration-test client

Source: R10. Priority: P2, first-phase foundation. Depends on: nothing. Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`manager/test/integration/helpers.ts:74` to :86 sends neither the session cookie nor the request header, so every protected request is refused.

## Scope

- Login through `POST /auth/login {username, password}`, which answers 204 with the cookie (api/routes/auth.ts:54). Send the cookie on every call and `x-requested-with: streaming-infra-manager` on every write (common/src/auth.ts:85 to :91).
- Credentials come from environment variables routed by `op run --env-file`. They are never printed, never copied into fixtures, and the suite never depends on a session reading a vault.
- The helper refuses to start unless `MANAGER_TEST_TARGET` equals the base URL it was given.
- A unique run id in every created name, a tracked inventory of created resources (deployments, groups, members, pools, viewers), cleanup only from that inventory. A name prefix alone establishes nothing. The suite never reaches review-20260907 or any existing deployment.
- Missing cookie, expired session and missing header are refused with the intended status, each tested separately.
- Setup fails clearly when prerequisites are absent. A skipped suite is never reported as a passing integration run.
- The integration README and commands match the current application.

## Where the design lives

PRD "**T10.**" in Fable round 1 section 5, OpenAI round 2 section 4, T10 line of "Question 8" in Fable round 2.

## Code anchors

manager/test/integration/helpers.ts, api/middleware/requireSession.ts, api/middleware/requireSameSite.ts, api/routes/auth.ts, common/src/auth.ts, manager/package.json `test:integration`.
