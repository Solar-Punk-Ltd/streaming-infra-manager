# T11 custom-file source correction, 2026-09-08

## Active cross-row dependency integration

Cross-provider review, OpenAI-hosted. Captured-version correction `ef269a861d0a7e80a6585f89ff71ae1e3c8e2ca8` is clean and accepted after RED `c0f1521`. One cloned version supplies root and contract defaults and is passed to admission without reselection. The existing locked ledger comparison refuses a newly published build before settings, status, intent or job mutation. Supplied captures are cloned before waits. Four actual HTTP/unit failures and a real SQL publication failure establish RED. Cancelled load-bound SQL runs are retained, not counted as passes.

Final evidence is 28 targeted HTTP/unit checks, three actual SQL publication/control cases, 31 existing ordinary-deploy controls and manager types. Logs `/private/tmp/t11-version-capture-{unit-green,sql-green,deploy-controls,types}.log`. The final SQL run took 3.97 seconds after exclusive scheduling. No broad suite was repeated, so the preceding full result remains 1095/1097 with two known T01 caller failures. Mutable host/legacy input capture remains open. T11 has no test process running and retains its own 61175 fixture.

The worker now has a read-only T04b execution retirement/restart and exact mounted-root attribution design assignment against `58eb319`, from its separate review tree. No T04b source edit or dependency merge is authorized by that design assignment yet. T01 owns operation lifecycle and success callbacks. The worker must not use or clean T01's 62527 fixture.

Exact-job write correction `1684131dca4ee4cef0a978d68c8027f03948e235` is clean and independently accepted after behavioral HTTP RED `838f68c`. Root reviewed the single SQL write, error mapping, fixtures, real held-write races and actual browser draft preservation. All 18 SQL, 27 focused HTTP, 13 browser checks and workspace types pass. Full manager is 1095/1097, with only the two known T01 creation-guard failures. Logs `/private/tmp/t11-job-write-{sql-final,http-final,browser,types-final,manager}.log`. Browser PID14690 and ports57281/57279 are gone. Only the owned 61175 database remains.

The separate defaults/publication correction is now approved for tests-first implementation. Read and clone one StackVersionRecord, derive both root and contract defaults from it, and pass it as the explicit optional third reserveDeploy argument. Claim clones it before awaits and uses the same record for attempt kind, root checks and the existing locked ledger claim. A supplied capture must never be reselected. Tests cover mixed-pair false acceptance/refusal, a real held A/B publication before admission, unchanged controls and mutation while waiting. Mutable host-input/legacy proof still depends on T04b and cannot be replaced by an extra last-minute read. This slice does not claim that filesystem boundary is closed.

Second exact dependency merge `f5a02caf05caa1d75d3bf2bef9ac32e03f1f3371` is independently accepted with parents `8f3e36a` and `c55c9d9`. The production conflict retains deletion-marker and active-job checks. Four real reference/ledger ordering cases retain both isolated holds and valid job admission. The missing-version overview fixture now simulates a missing read instead of deleting the bundled version through a removed fake API. All 248 applicable SQL cases, 300 common, 28 frontend and workspace types pass. Manager 1093/1095 has only the known two T01 split-caller failures. Logs `/private/tmp/t11-t04a-merge-{focus-sql,other-sql,removal-final,manager,common,frontend,types-final}.log`.

The accepted exact-job write uses `EngineSettingsWriteOwner`, containing the captured instance, intent, config revision, version and job reference. A single UPDATE also requires DEPLOYING and that active reference. Values are captured before awaiting. A confirmed replacement keeps `profile_instance_changed` 409. A same-instance loss of job authority returns fixed `engine_settings_changed` 409, with draft preservation. No second intent bump. The fake orchestrator issues a synthetic job for its settings fixtures, with exact cancellation. Actual SQL and HTTP tests cover real repository/orchestrator boundaries.

Separate next investigation: validation reads defaults through `engineDefaults(existing)` before the reservation captures a build. That helper separately reads root and contract. A same-version publication can replace build A with B between validation and claim. For ABR SRS, HLS_FRAGMENT=0.5 passes A's default ABR_FPS=30 but fails B's default25. Settings may already be stored when writeProfileEnv catches the mismatch. Confirm with a separate regression after the active-job fix. The correction must bind validation to the selected build and host-input revision, coordinated with T07/T04b, without weakening the deployment validation gate.

First merge `8430f29fe605a0bafc1ed2adc7e3618e60b5ca71` is independently accepted with exact parents `b9fb144` and `58eb319`. Root reviewed six conflict resolutions, including the test held after the completed ledger claim so a resumed caller cannot bump a replacement's intent. Workspace types, 47 actual SQL, 11 instance HTTP and nine focused common checks pass. Overlap is 134/136, with only the known T01 creation-guard failures. Logs `/private/tmp/t11-t04b-merge-{types-final,sql,focused-final,instance-final,common}.log`.

An inherited stale mock import prevents startup: T12 removed `uncheckedChequebookNotice` but mock-manager still imports it and allows unknown local-node funding. Root approved a separate test-first mock correction before the final T04a merge. Missing local node and unreadable balance must refuse with HTTP 502 and `bee_node_unreachable`, matching the actual production errorHandler and D02. Proven low funds retain HTTP 409 and `chequebook_unfunded`. Funded and no-owned-node/pool controls remain allowed. No production gating change is needed. Do not weaken the two T01 tests.

That mock correction is now accepted at `8f3e36af7c369bdc66fe843ee3bd8fd6cea2680c`, after startup RED `7e2e3a2`. Six authenticated funding cases, 10 existing mock-config HTTP cases, three shared-reader cases, three Chrome protocol cases and workspace types pass. Logs `/private/tmp/t11-mock-funding-{final,green,types}.log`. The fixture uses child-memory setup with no new control endpoint. All mock children are closed. The exact final T04a merge is now active.

`implement_t12_readiness` is assigned the existing `/private/tmp/t11-codex` on `fix/t11-effective-settings`, starting from clean `b9fb14477dab7175704c36b852d8040cb8d02ff6`. Root approved separate local merges of exact T04b `58eb319787a64b3e2b80a7c53e1782f0d2689187`, then final T04a `c55c9d93b17b75619b239104099de28cdfff2a43`. Semantic conflict resolutions require root review. Preserve the editor instance guard, atomic instance/intent/config/version/job ownership, T11 literal/coherent-read/draft behavior, T12 freshness and all deletion-marker admission checks. No second intent bump or package version change.

After dependency validation and root review, add the exact-job settings-write regression described below. The worker retains its own synthetic PostgreSQL container `6b755f793656af867ad33f9564fabc1a5d06f2d324a88cad91fe58f748fd656b` on loopback 61175 and may add synthetic `t11_test`. It must not touch the other worker's 62527 fixture.

Root re-read accepted `b9fb144` while the other workers progressed. That checkpoint uses its older orchestrator claim and has not integrated T04b's final instance/intent/config/version/job ownership. T11 integration must preserve the editor's explicit instance precondition and strengthen the settings write to the exact claimed job, intent and DEPLOYING status. `ProfileService.updateEngineSettings` currently passes only the claimed instance to the write, so a successor within that same instance remains a separate integration case. Use the accepted ledger claim rather than a second intent bump. Test held settings writes against a later job and keep draft-preserving 409 behavior. Dependency integration must be reviewed before new source changes.

## Final local checkpoint and handoff

Cross-provider review, OpenAI-hosted. T11 is clean and accepted at `b9fb144`. RED4811ae9 and GREENb9fb144 wire the captured instance into editor saves and align the mock with manager validation and post-body ownership checks. Final25 browser/mock checks and workspace types pass. Held-save replacement leaves the replacement untouched and preserves the typed draft. Current-instance saving still succeeds. Logs `/private/tmp/t11-save-instance-client-{green,types}.log`.

Final Chrome63854 and loopback59231/59234 are gone. No T11 database or browser fixture remains. The worker now owns the separate T04a guarded version-removal slice. Stronger active-job integration and immutable filesystem observation remain later dependencies. Local draft `prs/t11-effective-settings.md` is rewritten around the final behavior.


## Newest backend acceptance

Cross-provider review, OpenAI-hosted. Root accepts `9de434d` after reading its complete source and 11 actual HTTP plus6 actual SQL regressions. All618 manager checks and workspace types pass. Expected instance is enforced before claim and on the claimed row's settings, intent and cancellation writes. Stronger same-instance intent/job ownership remains the later T04b integration. Drawer/mock request wiring and final browser proof are active.

The exact12175d92335ea09036fef7a18911ee6ad04beba5fc757ac15c01a72a2e3c02a1 fixture is now removed and56899 closed. Cleanup's automatic approval timed out, explicitly permitted one retry, and that identical retry succeeded. No rejection was bypassed.


## Current UI acceptance and save fence

Cross-provider review, OpenAI-hosted. Coherent SQL537f14f, HTTPc1bf7a8, wordingb70c5bc and UI1b20121/ef2bdc6 through coverageb5982b1 are accepted. Root reviewed source and desktop/390-CSS-pixel screenshots. Nine actual browser scenarios pass,10 node tests including parent, with13 frontend unit checks and types. This is desktop responsive emulation, not a physical phone test.

The UI hides obsolete observations during render, cancels navigation reads, enforces a15-second read deadline, ignores late responses and preserves unsaved drafts across failures or changed identity. Config-file literals and defaults/overrides have distinct readable sources. Browser evidence `/private/tmp/t11-browser-evidence/{desktop,phone}.png`, log `/private/tmp/t11-ui-browser-coverage.log`. Worker verified Chrome47106 and ports53402/53403 gone.

A separate root finding remains active: the name-only save can mutate a same-name replacement after the page's read. A post-response identity check is too late. HTTP RED37b35b3 reproduces9 ownership/schema failures with2 controls. Approved fix adds optional strict UUID expectedInstanceId to the request, with the drawer always sending its captured instance. Legacy callers still bind the instance captured by the service. Atomic claim, settings write, intent write and cancellation must use the winning instance. No expected identity enters stored engine settings.

T04b worker owns the stronger ledger transaction with instance/intent/configuration revision/version and active job reference. Both use reservation.claimedProfile for the winning row. That later dependency integration must not restore name-only writes. Existing broader job callback lifetime checks are separate T01/T10 obligations.

Current worker-owned cached-image database is12175d92335ea09036fef7a18911ee6ad04beba5fc757ac15c01a72a2e3c02a1, name t11-settings-instance-37b35b3, loopback56899, t11_test, tmpfs. Previous416bb773 fixture was removed. Only its worker may clean the current fixture.

## Earlier checkpoints, superseded where noted above

## Latest observation checkpoint, 2026-09-09

Cross-provider review, OpenAI-hosted. SRS scope `306afe3` is accepted after78 focused tests and workspace types. Shared server-side mock readers `c830318` and removed-instance callback retirement `81e0373` are accepted after10 real authenticated mock HTTP checks. Their readers use current stored config and preserve literal, omitted and unverified distinctions. Old apply/watch callbacks cannot repopulate config maps after name reuse. T20 must run both explicit mock observation entrypoints.

Shared identity helper `2ec4ffd`, coherent SQL snapshot `537f14f` and HTTP identity `c1bf7a8` are accepted. Valid SQL RED `ae2618c` followed the fixture correction, then4 SQL checks pass. HTTP RED `eae779c` reproduced7 failures with1 control, GREEN passes8 HTTP,45 focused engine/control and11 mock checks. Full607 manager checks and workspace types pass. Logs `/private/tmp/t11-snapshot-{sql,http,mock}-*.log` and `/private/tmp/t11-snapshot-all-manager.log`. One captured version record supplies root, defaults, template and contract. No raw config enters the DTO. Initial SQL fixture setup failures at `789ec43` were not behavioral RED evidence.

The worker removed exact synthetic PostgreSQL container `416bb773e7f883a31fe21e6aa4a2c25b2187b4da3baab8b91a2b9ecb4e1378e2` and verified former port56014 closed. UI work is active after backend review. First helper checkpoint `b70c5bc` awaits root review, with10 focused cases and frontend types. Approved UI behavior keys both request and response identity, hides stale values on the first changed render, keeps draft inputs separate, and disables an old-instance draft after name reuse until reopened. Actual delayed-read/503 and unsaved-draft browser tests are required. Atomic filesystem coherence still depends on later T04 integration.

**Current assignment, 2026-09-09:** `implement_t12_readiness` resumed the approved shared observation assembler and OME API slice from clean `e0af243` in `/private/tmp/t11-codex`, branch `fix/t11-effective-settings`. Root accepted its preceding T10 helper checkpoint `953271c`. T03 dependency merge `6f9eba0` and the unused-import correction remain validated by 29 focused manager tests and workspace types. Logs `/private/tmp/t11-t03-baseline-tests-authorized.log` and `/private/tmp/t11-t03-baseline-types-green.log`.

Cross-provider review, OpenAI-hosted. Levi explicitly answered "Yes, override reviewer-only for the agreed local work". This resolves the former automatic rejection of the first T11 test-file addition. Do not repeat that permission question. Source/test edits, commits and disposable local tests are authorized. Pushes, main-v2 merges, GitHub writes, host access and dependency installs remain excluded. Report any new rejection without bypassing it.

First checkpoint is the shared known/literal/omitted/unverified observations and OME API. Preserve independent uploader interval evidence. Root reviews before SRS and UI integration. The design below is agreed scope from `issues/t11-effective-engine-settings.md` and ACCEPTANCE-AUDIT, not a new owner decision.

## Accepted shared assembler

RED `a38abb4` and GREEN `38be7b0` add the shared observation shape and strict effective projection. All 46 focused observation/settings/default tests and common types pass. Log `/private/tmp/t11-observation-green.log`. Root reviewed source and the six added behavior tests. Mandatory overview wiring and OME observations are the active next checkpoint. SRS/UI remain later.

## Accepted OME/API checkpoint

Clean `3c9ee89` implements mandatory observations and OME template paths after actual HTTP RED `ebde4bb`. Conservative mock GREEN `6c6b986` follows RED `c36f2fc`. Worker checks passed562 manager,277 common,3 frontend and2 mock tests plus workspace types. Root accepted the shared assembler and helper extraction, but identified one additional application-scope gap before accepting this checkpoint.

T03 permits extra applications under the template's virtual host. The OME reader currently enumerates only exact named template paths, so template video/audio duration4 plus an extra admitted application with HLS duration5 still returns known4. The approved correction uses parsed structural ancestry with Application identity variable, retains original required paths and observes extra matching HLS scopes per field. Equal values stay known. Conflicts and missing scalar leaves in additional HLS scopes are unknown. Unrelated publishers/branches do not contaminate HLS observations. Actual HTTP regressions must also show T03 admits the fixture. Root reviews the separate RED/GREEN before SRS/UI continuation.

The mock's temporary conservative unknown result is a bounded checkpoint. Final T11 mock integration must use the same stored-config readers as the manager so real literals have real source evidence. Its new `test/mock-engine-observations.test.mjs` entrypoint uses Node with tsx and development conditions and must be wired explicitly into T20.

The additional-application correction is now accepted at `28e1ee0`, after RED `cfe2b26` reproduced two actual HTTP failures. All four new fixtures also assert T03 admits the custom file. Conflicting additional HLS values and missing scalar leaves become unverified. Equal values remain known and unrelated RTMP applications do not contaminate them. All36 focused OME/T03 tests and types pass. Logs `/private/tmp/t11-added-app-{red,green,types}.log`. Root independently reviewed the source, regression and evidence.

## Approved SRS reader slice

The worker now implements a bounded tokenizer and structural reader for scalar observations, not an SRS validator. It supports bare/quoted words, bounded escapes, comments outside quotes, semicolons, braces and the two known standalone generated-block markers. Byte, token and nesting bounds refuse malformed or unsupported input as unverified. Template-derived HLS scopes include all matching vhosts. Explicit transcode engine scopes map FPS, preset, profile, threads, codec and applicable bitrate. Missing, duplicate, conflicting and mixed literal/environment readings remain explicit. Unknown includes degrade only fields they can extend, with a root include affecting all relevant fields.

Generated ABR vhost and transcode markers contribute uncertainty only to their respective HLS and encoder fields when ABR is enabled. They are removed when disabled by the selected entrypoint. Independently proven scalar fields remain visible. VBV seconds are never reverse-engineered from buffer arithmetic.

For audio bitrate, a `not-applicable` observation is valid only when every relevant explicit encoder unambiguously uses copy. Mixed AAC/copy, unknown codecs or opaque generated encoder content remain unverified. AAC without a bitrate is omitted/unverified. Tests cover all-copy, agreeing AAC, missing AAC bitrate, mixed codecs, unknown codec and explicit copy beside generated encoder content. File presence does not prove runtime activation. Root reviews separate RED/GREEN before shared mock wiring and UI work.

## Additional accepted review cases

Use a shared discriminated observation with known source `deployment`, `host`, `stack` or `config-file`, otherwise `omitted` or `unverified` with null value and a closed reason code. Derive `effective` only from known observations. Missing readings never silently become defaults. Resolve uncertainty per field.

The selected SRS entrypoint can generate an additional HLS vhost from environment values. An ingest literal4 plus `ABR_VHOST_PLACEHOLDER` can still produce active HLS0.5. Opaque generated HLS scopes prevent claiming one effective HLS scalar. They must not hide an independently proven encoder scalar. Explicit recognizable `vfps`, `vpreset`, `vprofile`, `vthreads`, `acodec` and applicable `abitrate` remain in scope. Do not reverse-engineer `ABR_VBV_SECONDS` from arithmetic.

OME's uploader poll interval is independent of XML in checked stack commit `ee99c368bd45c12defcb10ca726f0db0777defb0`. Compose passes the environment value to stream-uploader. Its engine registry loads `createOmeEngineFromEnv`, which reads the integer and passes it to `OmeHlsPuller`. Malformed XML must leave a proven interval750 visible while degrading XML-derived settings.

Key cached overview evidence to the requested profile name, instance, config revision, intent revision, updated timestamp, version and engine as available. A revision change must hide the old value on the first render, before the next passive effect. Test literal4, revision change, delayed replacement request,503 and no stale4 in card, summary or drawer. Also test a same-name replacement and unchanged timestamp with increased config revision. Ignore late older responses. The open drawer must refresh source evidence while preserving unsaved edits, since its current request only depends on name.

## Observed gap

The manager passes absent placeholder names to `effectiveEngineSettings`, which drops the corresponding values. The summary then says "not in the file". Replacing an OME segment placeholder with 4 therefore loses a perfectly readable value. The T03 test at `manager/test/unit/omeContract.test.ts:180` only checks missing-placeholder detection, despite its title claiming file-controlled display. A literal and an omitted directive need distinct observations.

## Proposed implementation boundary for review

Keep `EngineSettingsOverview.effective` as the map of known values. Add one shared per-field source/observation shape for the manager, mock and every UI consumer. It must distinguish deployment override, host default, stack default, parsed custom-file literal, omitted directive and unverified custom-file value. Source may not be inferred solely from a missing placeholder or an absent map key. Keep `notInConfig` only as the compatibility signal that the environment setting no longer drives the custom file.

The manager resolves custom-file values. The browser never parses the config. Reuse T03's strict OME parser through an explicit local T03 dependency merge into T11, preserving its pin/provenance history. Do not add another XML parser or dependency version. Reuse or extract a small path helper so template-derived locations and named application identity are not reimplemented inconsistently. This stack's actual template uses HLS, not only LLHLS. Derive the segment-duration/count locations from the selected template's matching setting placeholders rather than assuming either publisher name.

For SRS, use a bounded reader for recognizable directive/block syntax, without claiming it is the engine's validator. Parse comments, quoted strings, braces and semicolons as syntax, never regex-match a number from a comment. Template-derived hls_fragment and hls_window paths can yield reliable scalar observations. Complex transcode expansions, unsupported includes, malformed text, duplicate paths or ambiguous applications remain explicitly unverified rather than guessed. All additional safely identifiable scalar fields remain in scope. Missing metadata or unsupported syntax must not fail the whole deployment page or fabricate a number.

Across repeated template paths, return one effective value only when every relevant occurrence is unambiguous and agrees. A setting with differing values across video/audio applications is not one scalar value. Treat mixed literal/environment sources conservatively. A placeholder located only in a comment or unrelated branch is not a read of the setting. Validation remains separate from observation. Preserve T03 refusal rules and T01 recovery unchanged.

The Engine card, At a glance and settings drawer help use the same returned observation. A parsed literal shows its value and "set in config file". Omitted means "omitted from config, effective value unverified". Ambiguous or unreadable means "config value unverified" with Logs as the source for the running config. Saving an environment setting still must not imply it changes a literal-controlled directive. Do not add a forced config rewrite or silently change existing overrides.

## Test-first acceptance

1. Actual engine overview HTTP regression with OME's template, both segment-duration placeholders replaced by 4. Expect effective duration4 and file source, ignoring a conflicting stored/environment value. A literalized segment count is the same case.
2. Remove a mapped directive. Expect omitted/unverified, no file-source claim and no synthetic effective value. A remaining occurrence elsewhere cannot hide the missing required path.
3. Conflicting literals across video/audio, duplicate path, malformed XML and token in a comment are unverified or parser-refused as appropriate. HLS template paths work, not a hard-coded LLHLS path.
4. SRS scalar literal, comments, quoted syntax, nested vhosts, differing/duplicate directives and include/unsupported controls. Use synthetic files only, no real parser container.
5. Existing version defaults, valid host defaults, explicit overrides and clearing overrides retain their current passing values/sources. Template placeholders still resolve those defaults.
6. Frontend value/source helper and actual offline browser checks prove summary, card and drawer agree, and no stale number survives unavailable evidence. Mock uses the same DTO semantics.
7. Full relevant unit/common/frontend/types, independent review, then integrate the correction into T12/T15 and update T21 docs. No host, GitHub, database or engine-container action is required by this slice.

The exact parser API and shared observation shape need lead review before production edits. This proposal does not reduce the agreed scope or reopen an owner decision.
