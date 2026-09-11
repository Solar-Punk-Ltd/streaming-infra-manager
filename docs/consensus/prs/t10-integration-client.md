# fix: authenticate integration tests and restrict cleanup to confirmed creations (T10)

The integration client could not use protected routes. Its cleanup also treated requested names as ownership, which could delete a same-name replacement or hide a failed teardown. The client now signs in, records canonical successful creation identities before assertions, and uses guarded deletion with bounded, visible cleanup results.

Local branch `fix/t10-integration-client` is clean at `284790c`. It includes reviewed T01/T06 dependencies. This is a local draft. Nothing has been pushed, opened on GitHub or merged into main-v2.

## Behavior

- Require an explicitly declared manager target. Carry the session cookie and write header. Route credentials from the environment without printing their values.
- Record returned deployment instance IDs and group IDs/names. Requested names, matching prefixes, later GET results and current group membership never become cleanup authority.
- Claim profile removal by instance and intent. Keep its name occupied until filesystem cleanup finishes. Refuse a replacement and fence late failures or duplicate completion callbacks.
- Delete an owned group only after an atomic unchanged-identity and empty-membership check. Concurrently added members block deletion and are reported.
- Preserve original inserted identities in creation responses. Capture raw and typed creation routes before caller assertions, including equivalent encoded paths and actual serialized request bodies.
- Give each cleanup request a 5-second deadline and accepted deletion a 60-second disappearance deadline. Attempt independent resources, then report all failures and unresolved creation coverage. Preserve the original test failure separately.

## Validation

Cross-provider review, OpenAI-hosted. Independent source review accepted the final implementation and its regressions.

- 960 manager tests and 288 common tests pass.
- 31 actual PostgreSQL regressions pass, including replacement, lock-wait, concurrent group insertion, retained reservation and failed filesystem cleanup cases.
- Workspace type checks and diff checks pass.
- Synthetic loopback HTTP tests exercise the actual integration helper, serialized-body coverage, guarded deletion and Node after-hook failure reporting.

The actual authenticated Docker integration suite has not run. No host or live deployment was contacted. Detailed RED/GREEN commits and local evidence are in `../T10-CONTINUATION.md`.

## Remaining dependency work

T20 must invoke the final integration suite on an authorized disposable stack. T01 operation build-reference production is still being implemented. Its later integration must scope new operation holds by deployment instance while retaining ambiguous historical holds conservatively. Container enrichment remains name-based and is not used as cleanup ownership evidence.

The target declaration is a matching URL pair. It prevents a stale URL from passing without the corresponding declaration, but copying both values to another target still declares that target. This behavior is unchanged.
