# Integration tests

End-to-end happy-path tests that drive the **running** manager over HTTP and
verify real deployments actually come up with the right components, then
exercise modify / stop / remove and the group config-edit feature.

These are **not** unit tests — they create real Docker containers via the deploy
scripts, so they need the full local stack up and they take a few minutes.

## Prerequisites

The whole stack must be running and reachable (same setup the UI uses):

```sh
# from manager/
pnpm database:start      # Postgres
pnpm dev                 # manager API on :9876 (or `pnpm stack:start` for the dockerized stack)
```

Docker must be running (the deploys start Bee / SRS / client containers).

## Run

```sh
# from manager/
pnpm test:integration
```

Point at a different host/port with `MANAGER_URL`:

```sh
MANAGER_URL=http://localhost:9876 pnpm test:integration
```

## What it covers

| Test | Asserts |
| --- | --- |
| viewer lifecycle | deploys exactly `client + bee-gateway`; modify changes `feed_owner`/`notes` and redeploys; stop → `STOPPED`; remove → gone |
| streamer lifecycle | deploys `srs + bee-uploader` with `stream-uploader` held back (`pendingStamp`); modify; stop; remove |
| custom lifecycle | deploys exactly the chosen `components`; stop; remove |
| group config edit (Feature A) | 2-viewer group; edit `feed_owner` for the whole group in one call; **every member** picks up the new feed and stays up; then removing the members auto-deletes the now-empty group |

## Notes & limitations

- All resources are namespaced with the `itest-` prefix and removed on teardown
  (including after a failed test). Pre-existing deployments are never touched.
- Group size is capped at 2 on purpose — this is meant to run on a laptop.
- Removing a group's last member now auto-deletes the (empty) group, so the
  group test leaves nothing behind. A migration (`003_prune_empty_groups.sql`)
  also clears any pre-existing orphaned group rows on next startup.
- The suite reads timings generously (`waitForStatus` throws after ~4 min per
  deploy) so a genuinely stuck deploy fails loudly instead of hanging.
