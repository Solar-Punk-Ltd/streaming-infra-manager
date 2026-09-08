# Integration tests

This setup describes the authenticated T10 harness prepared on
`fix/t10-integration-client`. That branch must be integrated before using these
commands. The reviewed `main-v2` baseline at `d046ebf` still has the older
client. T20 workflow wiring and actual runner execution are separate checks.

End-to-end tests that drive a **running** manager over HTTP, the way the browser does: signed in, with the session cookie on every request and the write header on every write. They create real deployments through the API, wait for them to come up, exercise modify, stop and remove, and the group features.

These are **not** unit tests. They start real containers through the deploy scripts, they take minutes, and they remove what they created. They run only against a manager that was declared a test target, and their intended cleanup boundary is resources created by that run. The current
T10 ownership limitation below must be corrected before using a target that
already contains deployments.

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
names outside that run prefix. It attempts removal and waits for disappearance,
but currently catches deletion and polling failures. Successful teardown does
not prove that every attempted cleanup succeeded. Verify leftovers by the exact
run-owned identities before calling an integration run clean.

There is also an open T10 ownership correction. Some suites add a requested
name to their cleanup set before creation succeeds. A refused create therefore
leaves that name eligible for cleanup, and a matching prefix does not prove
that the run created the current deployment. The accepted fix requires an
inventory of confirmed created resources and refusal to touch replacements.
Until that correction is integrated, use only an isolated manager with no
pre-existing deployments. The funded review deployment is never this target.

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

## Notes and limitations

- Viewer-group cases use two members. The ABR pool cases create a fixed four-rung pool. Multiple suite files can run concurrently, so two is not a whole-suite resource cap.
- The waits are generous (`waitForStatus` gives up after about 4 minutes per deploy) so a genuinely stuck deploy fails loudly instead of hanging.
- Failed cleanup can currently be silent. Record any unresolved run-owned resource explicitly. Cleanup-failure reporting remains an acceptance correction, not a guarantee of the current helper.

## Separate local regression suites

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
