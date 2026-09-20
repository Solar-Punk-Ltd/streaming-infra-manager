# Continuation viewer browser regression

Status: active implementation evidence. Full media acceptance remains pending.
Date: 2026-09-21.
Reviewer: OpenAI-hosted Astra.

The focused browser suite mounts the actual watch page with a diagnostic player fixture. It proves that the page passes and retains the intended playback inputs. It does not prove HLS decoding or Swarm retrieval.

| Candidate | Result |
| --- | --- |
| Positive `8cad6dfe983232997a1fed4302206ccb92345549` | Worker executed the three focused Chrome cases successfully. They cover replay retained through live continuation, an existing live selection retained across a later run and explicit replay A to cumulative replay B selection |
| Negative `f3938d52e085a1e06d08a17aa794603ea5969b49` | Coordinator executed the same suite. Two cases failed and the unaffected live-selection case passed. Zero skipped or cancelled tests |

The negative tree differs from the positive tree by one deleted line in `packages/client/src/pages/StreamWatcher/StreamWatcher.tsx`: the real watch page no longer passes its captured `replay` prop. It is an isolated deliberate-fault branch and must never be merged.

The first failure observed an empty archived-master reference instead of the fixture's exact 64-character reference. The second observed an empty replay run instead of run 4. These are the intended missing-binding failures, not browser launch, dependency or compilation errors. The browser completed all three cases in about ten seconds.

Coordinator command:

```sh
bash /Users/kisslevente/Documents/git/estate/tools/lane.sh --name srs-viewer-negative-browser -- env CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' TSX_DISABLE_CACHE=1 node --import /private/tmp/srs-continuation-20260920-viewer/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 /private/tmp/srs-continuation-20260920-viewer-negative/e2e/test/browser/continuation.test.ts
```

The negative worktree temporarily linked its root, e2e, client and shared `node_modules` directories to the existing positive dependency installation. No package was installed. The fixture loaded the negative worktree's actual watch-page source. Those four links were removed after the run, with their destinations checked before removal. The negative worktree is clean.

Earlier full verification-box attempts stopped at unrelated fixture setup and unused-export failures. Their failures are not this behavioral evidence. The later full positive and negative box checks are still pending publication access. Actual cumulative media playback, seeking and ABR decoding remain R09 work.
