# fix: show engine settings with their source and protect editor saves (T11)

The summary, engine card and editor could disagree about settings. A custom-file literal disappeared as though it were omitted, and stale observations could survive a changed deployment. The page now shares per-field observations with explicit sources. The editor keeps unsaved text while refreshing evidence and sends the draft's deployment instance with each save.

Reviewed checkpoint `ef269a8` on local branch `fix/t11-effective-settings` carries T01/T03, the exact T04b/T04a safeguards, the settings-write job fence and captured-build validation. Mutable host-input integration remains open. This draft is not final acceptance. Nothing is pushed or merged into main-v2.

## Behavior

- The manager reads the profile and stored config together. The overview identifies the deployment instance, revisions, selected version and engine.
- SRS and OME readers distinguish parsed config literals, deployment overrides, host defaults, stack defaults, omitted fields and unverified readings. The known-value map contains only proven observations. Parsing a stored file is not proof that a running engine loaded it.
- Repeated or additional scopes must agree before one scalar value is shown. Unsupported includes, generated content, missing leaves and conflicting values remain explicitly unverified. The uploader poll interval is assessed independently of engine XML.
- The summary, engine card and editor use the same value/source wording. A literal says it is set in the config file. Changing an environment override does not claim to change that literal.
- A changed identity hides old evidence during render. Requests have a 15-second read deadline and are cancelled on navigation. Late old responses are ignored. Unsaved draft text survives failed reads and replacement notices.
- Saves include the captured instance UUID. Atomic admission, settings writes, intent writes and cancellation refuse a same-name replacement. Legacy API callers still bind the instance captured by the service. The guard never enters stored engine settings.
- The settings write also requires the exact claimed job, intent, config revision, version and DEPLOYING status in one SQL UPDATE. An old save cannot overwrite or cancel a same-instance successor job. That refusal returns 409 and keeps the editor draft.
- Validation reads one captured build for both root and contract defaults. Admission uses that same build. Concurrent publication refuses before settings or job state changes instead of silently selecting different defaults.
- The offline mock uses the same schema and observation readers. It checks replacement after awaiting the request body and preserves the same refusal behavior. Unknown local Bee funding refuses with 502, proven insufficient funds with 409. Synthetic funded and external-node controls remain allowed.

## Validation

Cross-provider review, OpenAI-hosted. Root reviewed source, actual HTTP and SQL races, browser regressions and desktop/narrow-screen screenshots.

- The final job-write correction passes 18 actual SQL, 27 focused HTTP, 13 browser checks and workspace types. Its full manager run passes 1095/1097. The two failures are known T01 split-caller integration cases, so this is not an entirely green branch.
- The later captured-build correction passes 28 targeted HTTP/unit checks, three actual SQL cases, 31 ordinary-deploy controls and manager types. The full suite was not repeated for this checkpoint.
- Preceding dependency validation passed 248 actual PostgreSQL, 300 common and 28 frontend checks plus workspace types.
- The earlier bounded backend instance correction passed 618 manager tests and workspace types.
- Six actual PostgreSQL save-ownership tests pass. Four earlier coherent-snapshot SQL tests also passed at their checkpoint.
- Eleven actual service/orchestrator HTTP cases cover replacement before and after claim, legacy callers, missing/busy targets and request-field validation.
- The final browser/mock run passed 25 checks, including 11 browser scenarios plus the parent, 10 authenticated mock HTTP cases and 3 observation checks.
- Browser tests cover stale and late reads, deadlines, navigation cancellation, unsaved drafts and held-save replacement. Desktop and 390-CSS-pixel layouts were visually reviewed. This is responsive emulation, not a physical phone run.

Detailed commits and logs are in `../T11-CONTINUATION.md`. Earlier browser/listener fixtures were removed. The worker now retains its own synthetic PostgreSQL fixture on loopback 61175 for the active correction. No host or live deployment was contacted.

## Remaining dependency integration

T04b's stronger claim, T04a's removal safeguards, the exact claimed-job settings write and captured-build validation are implemented. Capturing mutable host inputs for validation and execution remains open. Immutable filesystem observation, remaining T12 integration and final T20/T21 synchronization remain open. These limits do not reopen the agreed task scope.
