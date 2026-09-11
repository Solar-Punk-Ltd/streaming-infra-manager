# feat: publish bundled artifacts with durable identity and private execution copies (T04b)

This local draft is incomplete. Artifact capture, sealing, publication, pruning and execution-copy helpers are reviewed. The core job producer and failure fence are reviewed, but two T01 integration tests remain failing and the final deploy/CLI callers have not been activated. Do not treat the branch as ready to merge or deploy.

Branch `fix/t04b-bundled-builds` includes reviewed T04a, T06, T01 and T12 dependencies. Current clean checkpoint is `58eb319`. Main-v2 remains unchanged. Nothing has been pushed or opened on GitHub.

## Reviewed behavior

The previous manager deployment could replace a directory still mounted by running containers. A shared incoming path and restart adoption also allowed publication identity to drift from the selected payload.

The new helpers export the pinned commit into a private tree and capture one committed host-input revision under the shared advisory lock. They preserve the complete input set, including intentional absence. A canonical package manifest binds shipment identity, source commit, input hashes, path types, modes and content.

Each consumer claims an exclusive package directory. Publication records the candidate before final placement, selects one verified materialization, and updates the active database reference with its receipt in one transaction. A replay returns its historical receipt without reactivating an older build. A later publication defeats an earlier stale activation. Pending candidates and unresolved artifact holds protect pruning.

Execution helpers create independent writable copies with external ownership metadata. Durable records bind source build, profile instance/intent, target daemon and exact job reference. Copying and potentially launched executions retain their holds. Unstarted cleanup is exclusive. Filesystem verification refuses changed bytes, aliasing and conflicting destination ownership.

## Validation so far

Cross-provider review, OpenAI-hosted. Reviewed execution helpers are `cd89978` and `4b0d32b`.

- Execution checkpoint passed 30 new SQL tests, 17 file tests, 140 total SQL tests, 947 manager tests and types.
- T12 dependency merge `3d38b76` and fixture correction `a7d4145` passed 963 manager, 151 SQL, 289 common and 18 frontend tests plus workspace types.
- Core job and failure-fence checkpoint passed 191 SQL checks and workspace types. Manager tests pass 961 of 963. The two known T01 integration failures are explicitly open.
- Earlier capture/materialization regressions cover payload mutation, symlink escapes, incomplete destinations, publication replay, conflicting claims and pruning races.

These tests use synthetic local files and disposable PostgreSQL. No real engine build, image pull, host operation or deployment ran. Exact RED/GREEN evidence is in `../T04B-CONTINUATION.md`.

## Work still required

- Close the T01 revision integration failures while retaining the accepted atomic job producer, exact cancellation and duplicate initial-claim refusal. Migration 027 records the active job. Historical ambiguous ownership remains unfilled.
- Integrate T01 begin/revert with that transaction and produce retained operation artifact holds.
- Guard generic version removal before any files are deleted.
- Complete observed execution retirement and mounted-root attribution. No age-based release or assumed absence is sufficient.
- Make runtime preparation write only private execution copies. The remote fixed copy directory needs unique execution ownership.
- Wire the shipment CLI and manager upgrade sequence, then qualify the full flow separately.

The original staged-rsync and orphan-adoption implementation is superseded by this corrected design. Earlier text claiming that missing versions may fall back to bundled, or that any complete orphan may be adopted, is not the accepted behavior.
