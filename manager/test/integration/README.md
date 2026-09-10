# Integration tests

This setup describes the authenticated T10 harness as it stands on
`feat/ai-remediation` on 2026-09-10. It is not on `main-v2`. These instructions
are not authorization for a deployment run, and no run of this suite against a
real deployment has happened.

End-to-end tests that drive a **running** manager over HTTP, the way the browser does: signed in, with the session cookie on every request and the write header on every write. They create real deployments through the API, wait for them to come up, exercise modify, stop and remove, and the group features.

These are **not** unit tests. They start real containers through the deploy scripts, take minutes and remove confirmed resources created by their run. They run only against a manager explicitly declared as a test target. The client and manager must both include the ownership guards described below. A test-target declaration does not replace the agreed capacity, spending and cleanup limits for an actual run.

## What the suite needs

1. The stack, running and reachable, the same setup the UI uses:

   ```sh
   # from manager/
   pnpm database:start      # Postgres
   pnpm dev                 # manager API on :9876
   ```

   Docker must be running. The deploys start Bee, SRS and client containers.
   A separately configured Docker manager started by `pnpm stack:start` uses
   Compose project `streaming-infra-manager`. Its API port9876 is internal.
   The web proxy publishes `http://127.0.0.1:8080` by default, or the configured
   `WEB_PORT`. Set both target URL variables to that proxy URL when using it.
   Do not use the development API URL for an unpublished container port.

2. A user to sign in as. The manager has no sign-up. Create one with the manager's CLI and keep the pair in 1Password (see [Authentication and public access](../../../docs/features/auth-and-public-access.md)). In the api container:

   ```sh
   # from manager/, for the configured Docker stack
   op read "op://<vault>/<item>/password" | docker compose -p streaming-infra-manager -f ./docker-compose.yml exec -T api node dist/cli.js user:add itest --password-stdin
   ```

   Against a manager started with `pnpm dev`, the same CLI runs from `manager/` as `pnpm exec tsx --conditions=development src/cli.ts user:add itest --password-stdin`.

3. The environment, filled by `op run` so the pair is never typed, printed or written to a file:

   | Variable | What it is |
   | --- | --- |
   | `MANAGER_URL` | Development API URL, default `http://localhost:9876`, or the configured Docker web-proxy URL, default `http://127.0.0.1:8080`. |
   | `MANAGER_TEST_TARGET` | The same URL, written again. It says this manager is a test target the suite may create and remove deployments on. The suite refuses to start when it is missing or names a different manager. |
   | `MANAGER_TEST_USERNAME` | The user to sign in as. |
   | `MANAGER_TEST_PASSWORD` | Its password, as an `op://` reference. |
   | `MANAGER_TEST_RUN` | Optional, one to eight lowercase letters or digits. Gives every suite file the same run id. Without it each file is a run of its own, which is fine. |

   Copy `env.example` to `env.itest` in this directory, which git ignores, and fill in the vault references.

## Run

```sh
# from manager/
op run --env-file test/integration/env.itest -- pnpm test:integration
```

A suite that cannot start fails in its first hook, in words, and creates nothing. Missing declaration, unreachable manager and a refused sign-in are three different messages. No message ever contains the password.

## Resource ownership and cleanup

Requested resources are named `itest-<run>-<what>-<random>`. Teardown refuses
names outside that run prefix. The prefix alone is not deletion authority.
Successful creation responses register validated deployment instance identities
before test assertions run. A refused or lost response grants no cleanup
authority. Malformed responses grant authority only for independently validated
identities, and unresolved coverage is reported for operator inspection.

Every profile removal sends its confirmed instance ID. The manager compares
that identity atomically when claiming removal, before scripts or file cleanup.
A same-name replacement is retained. Cleanup does not acquire new authority
from current group membership. An empty-group deletion checks the recorded group
identity and empty membership together and never cascades to new members.

Cleanup continues across independent resources and reports all failures in an
aggregate error. Request/header/body work defaults to five seconds per call,
and accepted deletion is observed for up to 60 seconds with one-second polls.
Timeouts do not automatically retry a write. Unknown creation coverage is also
reported. No failed cleanup is silently counted as a clean run.

These guards are locally accepted at T10 `284790c`, including the integration
after hooks. They have not been exercised against a live deployment by this
remediation session. The funded review deployment is never a disposable target.

## What it covers

| Test | Asserts |
| --- | --- |
| signed in (`auth.test.ts`) | a read with the cookie is answered, a read without it is refused with 401, a write without the request header is refused with 403 before the body is read, the cookie of a session that was signed out is refused with 401 |
| viewer lifecycle (`profiles.test.ts`) | deploys exactly `client + bee-gateway`, modify changes `feed_owner` and `notes` and redeploys, stop gives `STOPPED`, remove leaves nothing |
| streamer lifecycle | deploys `srs + bee-uploader` with `stream-uploader` held back (`pendingStamp`), modify, stop, remove |
| custom lifecycle | deploys exactly the chosen `components`, stop, remove |
| group config edit (`groups.test.ts`) | 2-viewer group, edit `feed_owner` for the whole group in one call, every member picks up the new feed and stays up, removing the members deletes the empty group |
| group resize (`group-resize.test.ts`) | grow a group by one member, deploy the grown group, remove a member, remove the rest, the group deletes itself |
| ABR pool and uploader (`abr-node-pool.test.ts`, `abr-uploader.test.ts`) | the pool's publisher assembly and the uploader's Bee target rules, see each file's header |
| engine config startup failure (`engine-startup-failure.test.ts`) | a stored SRS file the manager's own check accepts and the engine exits on ends the rollout in `reverted`, the deployment comes back `RUNNING` on the previous file, and the card's notice offers nothing to press |

## Notes and limitations

- Viewer-group cases use two members. The ABR pool cases create a fixed four-rung pool. Multiple suite files can run concurrently, so two is not a whole-suite resource cap.
- The waits are generous (`waitForStatus` gives up after about 4 minutes per deploy) so a genuinely stuck deploy fails loudly instead of hanging.
- A lost creation response may leave a resource whose identity was never confirmed. The suite reports that uncertainty and does not search by prefix and delete candidates.
- T10's final local checks passed 960 manager, 288 common and 31 actual SQL tests plus types. Synthetic HTTP tests exercise the real helper and cleanup reporting. They do not establish that this deployment integration suite ran.

## Separate local regression suites

Three files moved out of this directory on 2026-09-10. `localDockerUnix.test.ts`,
`nativeSupervisedForward.test.ts` and `sshForwardSupervisor.test.ts` are now in
`manager/test/native/`. They own temporary Unix sockets and fork synthetic Node
children, and they need no manager, no Docker socket and no target declaration.
Here they were picked up by `test:integration`, which refuses to start without
`MANAGER_TEST_TARGET`, so they ran nowhere. Run them from `manager/` with
`pnpm test:native`, which needs no environment beyond a `DATABASE_URL` that
names nothing, and the `checks` workflow runs them on every pull request.

The integration suite above creates deployments. The remediation's SQL suites
use disposable local PostgreSQL databases with synthetic data instead. Each
suite checks an explicit task-specific port variable and owns its test schemas.
Consult the corresponding test header for the database name and user. Setting
only `DATABASE_URL` does not select these suites' test target. Never point them
at a deployment database. A skipped SQL suite is not a passing database check.

Offline browser regressions use a mock manager and an isolated browser profile.
They exercise UI behavior without Bee, chain RPC or funds. Their harness owns
its browser processes and listeners. Cleanup must target those exact resources,
not other sessions' browsers, shared development servers or containers.

The SRS, OME and shared-image Docker regressions are separate again. They build
or start real test containers and require their own execution authorization.
Neither a unit run nor permission to run a disposable database authorizes them.
The funded `review-20260907` deployment is never a disposable integration target.
