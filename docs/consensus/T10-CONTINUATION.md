# T10 continuation, 2026-09-09

Cross-provider review, OpenAI-hosted. Local implementation is committed, tested and independently accepted through `284790c96547a0a3d6f75e4d120d676257874fc0`. Worktree `/private/tmp/t10-codex`, branch `fix/t10-integration-client`, clean. Main-v2 remains `d046ebf`. Nothing was pushed or merged there.

Levi explicitly authorized the reviewer-only override for local edits, commits and disposable tests. Pushes, GitHub writes, main-v2 merges, host access and live integration remain excluded.

## Result

The client signs in and carries its session cookie and write header. Its declared target guard remains required. Cleanup now records canonical successful creation identities before assertions. Requested names, prefixes and current group membership do not grant deletion authority.

Profile DELETE carries the recorded instance. The manager atomically claims that instance and intent, fences failure/completion, and holds the row and name through file cleanup before releasing reservations. A same-name replacement is refused. A synchronous terminal latch prevents duplicate completion/error finalization. The unused public name-only deletion API was removed.

Group DELETE requires the recorded ID and name. One transaction locks allocation, locks the group, then takes a fresh membership count after any wait. Changed or nonempty groups are refused. It never adopts or deletes a newly added member. Existing automatic empty-group deletion uses that same locking boundary.

Group/create/resize responses preserve the identities actually inserted. A fresh same-instance row may supply newer status, but a name-based reread cannot replace the creation identity. Container enrichment still reads by name and is not claimed to be an identity-coherent container snapshot. Cleanup authority uses the canonical inserted instance, never that enrichment.

All actual integration after hooks and explicit profile removals use the confirmed inventory and bounded HTTP adapter. Requests have a 5-second cleanup deadline and accepted deletion a 60-second disappearance deadline. Independent cleanup continues after failure, then reports an aggregate error. The Node runner retains the original assertion separately. Unknown creation outcomes and incomplete member coverage remain visible. Raw JSON, toJSON, query/trailing-slash/case variants and encoded canonical group IDs are accounted for.

## Evidence and review

- Final `960` manager tests, `288` common tests and all workspace type checks pass. Logs `/private/tmp/t10-final-{unit,common,manager-types,common-types,frontend-types}.log`.
- `31` actual PostgreSQL tests pass for profile removal, empty-group races and reservation retention. Log `/private/tmp/t10-legacy-api-sql.log`. No skips. Types pass in `/private/tmp/t10-legacy-api-types.log`.
- Actual helper loopback HTTP tests exercise serialization, guarded deletion and original-plus-cleanup failure reporting. The latest focused helper set passed `39` tests. Logs `/private/tmp/t10-invalid-count-{red,green,types}.log`.
- Independent worker review accepted production ownership, group API/creation identity and the final cleanup deltas. Root reviewed the SQL cases, source and resulting evidence. No live manager or deployment was contacted.

Selected RED to GREEN trail:

| Correction | RED | GREEN |
| --- | --- | --- |
| Owned profile removal | `6e5c347` | `1223565` |
| Single terminal callback | `2ba41f0` | `fc69e40` |
| Profile HTTP/script ownership | `162eb29` | `0387091` |
| Atomic empty-group removal | `dc6be68` | `a81f007` |
| Empty-group HTTP guard | `df48253` | `327e7b7` |
| Canonical created-instance responses | `a8da0a0` | `5bf9ee0` |
| Cleanup HTTP adapter | `40a5f2e` | `95ea24b` |
| Confirmed-resource client | `bf6dace` | `a82a005` |
| Actual helper wiring | `fdfaba4` | `5bd730b` |
| Effective serialized request | `12670b8` | `67f5cc0` |
| Unknown and invalid count coverage | `b6b53fc`, `b87063a` | `f8c43f7`, `1b53f09` |

Encoded parameter RED `47fe1f6` included the real `%37` case and three overbroad synthetic expectations for numeric forms that the strict API refuses. `b96a4c3` corrected those fixtures to valid encoded/case/query/trailing variants and restored strict canonical-digit validation after decoding. Do not describe07,7.0 or7e0 as accepted group IDs. Earlier fixture failures from missing DATABASE_URL, invalid group size or missing optional dependencies were corrected setup errors, not behavioral RED evidence.

Dependency merges are T06 `c932cbe`, T01 `796056d` and latest T01 `d0a48d0`, with the duplicate fixture field fixed separately in `61f6295`. Final ownership logic was retained during the last merge.

## Resource cleanup

Root removed only its exact synthetic PostgreSQL container `c8ba2acf5376c0ced0b4e629631fb94e8fb0fc7a72c601cc391a8ea098c3f298`. It held tmpfs databases t10_test and temporary t06_test. Docker inspect confirms the container is absent and former loopback53234 has no listener. No root T10 fixture remains.

## Remaining integration obligations

The real authenticated Docker integration suite has not run. It needs a separately authorized disposable stack and routed credentials. Passing local SQL and synthetic HTTP is not evidence of that run. T20 workflow integration remains open.

T01 still has to produce operation build references. Once explicit instance ownership is available on those references, T10's current global operation-hold predicate must become instance-scoped for new holds while retaining ambiguous historical holds conservatively. This is a known later dependency integration correction. Do not claim cross-row build/removal integration complete before it.

Local PR draft: `prs/t10-integration-client.md`. The funded review deployment was untouched. The historical0.5 BZZ submission remains unverified.
