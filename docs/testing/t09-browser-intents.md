# T09 browser intent contract

The first browser slice saves an immutable transfer intent before any submission is allowed. It has no money API or component wiring yet.

`ConfirmedTransferInput` contains only the request UUID, stable numeric account ID, original profile name, canonical `profileInstanceId`, direction, exact integer PLUR amount and creation time. It never stores a profile object, endpoint, password, private key or session token.

`IndexedDbTransferIntentStore.confirm(input, expectedCurrentRequestId)` reads the active pointer, checks it and writes the intent and pointer in one native IndexedDB transaction with strict durability. All dependent requests stay inside transaction callbacks. Only `transaction.oncomplete` returns `kind: created`, which grants that caller permission to continue toward the initial POST. A losing caller receives `kind: existing` with the winning immutable intent. A successful individual write cannot grant permission if the transaction subsequently aborts.

Pointers are scoped to the current browser origin, account ID and deployment instance. They are retained after terminal transaction evidence. Explicit replacement must compare the current pointer. It retains earlier intents for recovery. A stale tab restores the current intent. A corrupt or missing pointed-to record refuses replacement. There is no unlocked memory or localStorage fallback.

`current(accountId, profileInstanceId)` restores that scope. `find(requestId)` reads the exact saved intent. These methods never send a request to the manager. A controller must recover the server record using exact request-ID GET. A 404 or unavailable response cannot authorize a new UUID or automatic resend.

Version 2 adds optional observation links separately from the immutable intent. `recordExact` checks request, actor, profile name and instance, direction and amount. It retains one frozen operation and node identity and refuses contradictory replacement. `recordBlocking` saves only a separate blocking operation ID. It cannot populate or replace the intent's own link. Related node links are scoped to the original account. These links provide navigation and context only. They cannot authorize resend, replacement or settlement. A missing or damaged link does not replace exact request-ID recovery.

The next controller slice must require a fresh uncached exact detail response before an explicit New transfer confirmation. It must include full response evidence, show a terminal state and contain no conflict. History summaries cannot grant that permission. A new confirmation still checks the pointer atomically. Same-ID explicit retries retain the original account, name, instance, direction and amount. Authenticated controller state and evidence presentation follow in that slice.

## Native verification

The harness is `frontend/dev/t09-intent-tests.html`. It uses generated synthetic intents and temporary IndexedDB names. The node runner is `node --test frontend/test/transfer-intent-browser.test.mjs`, with a dedicated local Vite server on 127.0.0.1:54291. The existing Chrome helper creates one temporary profile per run, permits only this test origin, bounds protocol requests, stops its exact child and removes its exact temporary profile.

Chrome 152.0.7977.83 passed nine in-page cases and a separate two-tab case. Coverage includes concurrent confirmations, reload, current-pointer replacement, unrelated account or instance scopes, immutable UUID payloads, invalid input, abort after an individual write succeeds damaged pointer refusal and exact observation-link isolation. Two real tabs confirm concurrently, reload and prove that an old pointer cannot replace the newer intent. Workspace typechecks and `git diff --check` passed. This is persistence evidence only. It does not verify the future POST controller or complete T09.
