# Integration tests

End-to-end tests that drive a **running** manager over HTTP, the way the browser does: signed in, with the session cookie on every request and the write header on every write. They create real deployments through the API, wait for them to come up, exercise modify, stop and remove, and the group features.

They start real containers through the deploy scripts and take minutes. They run only against a manager declared as a test target. Cleanup requires confirmed creation identities.

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

## How cleanup proves ownership

Every requested resource name contains `itest-<run>-<what>-<random>`. A matching prefix is only a filter. The helper records successful response identities before the calling test can fail an assertion. It never adopts a requested name, a later GET result or a group's current members as cleanup authority.

Profile cleanup sends the recorded `instance_id` as `expectedInstanceId`. The manager claims that instance atomically and keeps its name occupied until file cleanup completes. If another instance now has the name, cleanup leaves it alone. Group cleanup requires the recorded group ID and name and an atomic empty-membership check. A newly added member blocks group deletion and is reported, not adopted.

Each cleanup request has a 5-second deadline. Accepted removal has a 60-second disappearance deadline. Cleanup attempts independent confirmed resources and reports all failures together. Lost or malformed creation responses and unknown member coverage remain unresolved. They grant no guessed deletion authority. The Node test runner reports cleanup failure separately from the original test failure.

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

- Viewer group fixtures use 2 members. ABR pool fixtures create 4 rungs.
- `waitForStatus` gives up after about 4 minutes per deploy. Cleanup has the shorter deadlines above.
- A lost creation response can leave a resource whose identity was never confirmed. The suite reports the unresolved creation and requires operator inspection. It does not search by prefix and delete candidates.
- Synthetic unit HTTP tests exercise the real helper and failure reporting. Passing them is not evidence that this live integration suite ran.
