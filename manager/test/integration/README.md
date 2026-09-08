# Integration tests

End-to-end tests that drive a **running** manager over HTTP, the way the browser does: signed in, with the session cookie on every request and the write header on every write. They create real deployments through the API, wait for them to come up, exercise modify, stop and remove, and the group features.

These are **not** unit tests. They start real containers through the deploy scripts, they take minutes, and they remove what they created. They run only against a manager that was declared a test target, and they never touch a deployment they did not create.

## What the suite needs

1. The stack, running and reachable, the same setup the UI uses:

   ```sh
   # from manager/
   pnpm database:start      # Postgres
   pnpm dev                 # manager API on :9876 (or `pnpm stack:start` for the dockerized stack)
   ```

   Docker must be running. The deploys start Bee, SRS and client containers.

2. A user to sign in as. The manager has no sign-up. Create one with the manager's CLI and keep the pair in 1Password (see `docs/features/auth-and-public-access.md`). In the api container:

   ```sh
   op read "op://<vault>/<item>/password" | docker compose exec -T api node dist/cli.js user:add itest --password-stdin
   ```

   Against a manager started with `pnpm dev`, the same CLI runs from `manager/` as `pnpm exec tsx --conditions=development src/cli.ts user:add itest --password-stdin`.

3. The environment, filled by `op run` so the pair is never typed, printed or written to a file:

   | Variable | What it is |
   | --- | --- |
   | `MANAGER_URL` | Where the manager is. Default `http://localhost:9876`. |
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

## What the suite never touches

Every resource it creates is named `itest-<run>-<what>-<random>`. The teardown removes names carrying this run's prefix and nothing else: a name without it in a teardown set fails the teardown after the run's own names are gone, so it is seen rather than acted on. Deployments that were there before, on any manager, are never listed, changed or removed by the suite.

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

- Group size is capped at 2 on purpose. This is meant to run on a laptop.
- The waits are generous (`waitForStatus` gives up after about 4 minutes per deploy) so a genuinely stuck deploy fails loudly instead of hanging.
- A leftover after a failed teardown is reported by the test that created it. It carries the run id in its name.
