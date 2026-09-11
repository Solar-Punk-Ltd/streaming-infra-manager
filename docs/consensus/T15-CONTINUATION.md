# T15 preparation, 2026-09-08

## Accepted local checkpoint, 2026-09-09

Cross-provider review, OpenAI-hosted. T15 is clean and lead-approved at `8d326aa229607aea0abd111ac3e6ada17d2107f2`. Levi explicitly approved the reviewer-only override for the remaining agreed local work, including this final commit. The commit exactly matches the previously reviewed and tested staged wizard correction. A fresh diff check passes. No code changed between the final browser/type verification and this commit, so those checks were not repeated solely to commit it.

The implementation preserves the uploader draft in memory through nested pool creation, validates the returned group/members before using them, selects the exact compatible pool and keeps the uploader unsubmitted. The temporary creation overlay retires when global state catches up. A separate post-acceptance check continues after retirement, and excludes an absent or incompatible pool despite a later stale global response. Cancellation, sign-out and supersession cannot restore the abandoned draft. Remaining member readiness is informational and does not add a new resource-creation gate.

Evidence includes 28 frontend tests at `32467bb`, seven T08 browser cases, workspace/frontend typechecks and the actual T15 browser round trip. The final two membership-response order regressions pass, with the last workflow completing in 9.85 seconds. Screenshot `/private/tmp/t15-browser-evidence/pool-prerequisites.png` was visually reviewed. Exact browser/listener cleanup was verified as recorded below. No live services, funds, dependencies or host were changed. The local draft is `prs/t15-abr-prerequisites.md`.

Aggregate integration still needs the newer T12 phase and T11 settings corrections, T09's final UI and T20's portable browser harness wiring. Proposed navigation names remain recommendations for Levi, not implemented capability changes. Earlier pending-approval and uncommitted statements below are historical.

**Latest:** HEAD `6385ac6`, branch `codex/t15-pool-prerequisites`, worktree `/private/tmp/t15-codex`. Only `frontend/src/forms/wizard/NewDeploymentWizard.tsx` is staged. Its correction keeps post-acceptance membership verification independent from retirement of the temporary creation overlay. Fresh incompatible or absent membership excludes the accepted group even if an older global response arrives later. Both browser response orders pass, plus frontend types and diff checks. The lead reviewed the staged correction. Automatic approval review rejected its final commit under the reviewer-only preamble. The worker stopped and did not retry. A combined explicit override for this commit and T12's rejected source edit is pending. Preserve the staged file.

Earlier accepted commits include response validation `9a6c304`, browser workflow `32467bb` and native no-store request passthrough `37c50e6`. The final response-order RED is `6385ac6`. The last browser workflow passed in 9.85 seconds, with screenshot `/private/tmp/t15-browser-evidence/pool-prerequisites.png`. The worker verified Chrome PID38580 gone and listeners52358/52356 absent. No test processes remain. Historical checkpoints below are superseded.

**Active resume:** Levi explicitly approved the reviewer-only override for local edits/commits and disposable databases. The previous local commit block is resolved. T08 merged at `4f608e4`, preserving the T12 overview and phase column, T08 running-commit display and the newer browser helper. Initial helper GREEN `dc09a21` passes four focused tests. Its known components-nullability type error is being corrected with the accepted unknown-response guards. The worker is active, so this is not a clean final handoff. Historical pause statements below no longer prohibit the authorized local work.

## Current checkpoint and approval block

The prepared tree is now on `codex/t15-pool-prerequisites` at `2c0bbf5`. Reviewed T12 `0359161` is merged. Four draft-handoff tests are committed RED. The untracked `frontend/src/forms/wizard/poolDraft.ts` makes those four tests pass. The untracked `frontend/test/pool-draft-browser.test.mjs` reaches uploader settings and fails at the missing Create a storage pool action. Owned browser resources were cleaned. Preserve these files.

Automatic approval review rejected the local GREEN commit twice, including a retry supplying the actual user's implementation and agent authorization. It said the reviewer-only repository preamble prohibits commits or other writes. The lead asked Levi for an explicit override for local edits and commits in existing task worktrees. Until he replies, dependent source edits, merges and commits remain paused. Do not bypass the rejection through another agent or tool. T08 `347c7dd` is ready to merge once this is resolved.

The approved design keeps the outer uploader draft in React memory, switches to a fresh pool form carrying only host and version, and returns to Settings with the exact compatible returned group id. No automatic uploader submit. A generation/mounted guard must prevent late completion after outer cancellation or sign-out from restoring the discarded draft. Per-member observations use T12's read-only semantics and show blockers without adding a new funding gate to the existing create-config capability.

Two helper corrections were reviewed as designs but remain unimplemented: treat accepted JSON as unknown and structurally reject missing/null groups, malformed profile arrays and null/non-array components without throwing. Retire the local pool overlay once the global store catches up, so a later authoritative removal cannot resurrect the pool or use its stale result string. Tests must cover both. The worker is doing read-only T04a review preparation while T15 writes are paused.

## Resumed design review, 2026-09-08

Cross-provider review, OpenAI-hosted. Levi asked to continue the remaining work. A consolidated explicit permission question now covers the reviewer-only local-write override and disposable cached-image test databases. No answer has arrived at this checkpoint. The prior rejection has not been retried or bypassed. Read-only inspection confirms HEAD `2c0bbf5`, no tracked changes and the two expected untracked files.

The lead accepted this correction order for implementation once permission arrives:

1. Merge T08 `347c7dd`, preserving its explicit selection and late-version picker behavior.
2. Validate accepted JSON before any group route, profile merge or readiness rendering. `wizardSubmit.ts` currently dereferences `result.group.id` too early. Cover accepted null, missing/null group, malformed profile arrays, null components and null containers. Use tagged cancellation and accepted outcomes so accepted JSON null cannot masquerade as cancellation. An accepted but unusable response retains the uploader draft with a clear notice. Never automatically repeat group creation.
3. Retire the temporary pool overlay permanently after the authoritative group and all compatible members arrive. A later deletion or conflicting same-name group must invalidate selection, not resurrect the accepted response or use a stale pool result string.
4. Wire the nested in-memory flow. The outer draft retains all fields, with a cloned components array. The fresh pool inherits only host, custom host and explicitly selected version. Its request must not contain uploader notes, keys, passphrases or source choices. A successful return changes only the step, pool selection mode and exact compatible group id. Cancellation restores the original choices.
5. Invalidate generations synchronously on outer cancellation, return and unmount. Guard mergeProfiles, reload, toast and navigation as well as component state. A late response after sign-out or a newly opened wizard cannot restore a discarded draft.
6. Use keyed T12 read-only member observations. Funding and stamp blockers remain visible without becoming a new gate on configuration creation. Finish the offline browser tests, including external pool, custom and group controls.

Compatibility requires a positive safe integer group id, the requested name and ladder kind, `ABR_LADDER_SIZE`, distinct expected member names, matching group ids and exact required rung components. Guard every field consumed by the readiness view before passing the response to it. The preserved browser RED currently reaches the missing Create a storage pool action. No new test execution is claimed by this review.

## Historical preparation details

The lead prepared `/private/tmp/t15-codex`, branch `codex/t15-pool-prerequisites`, from main-v2 at `d046ebf`. No implementation or dependency merge has started there. Wait for the current T12 handoff, then merge its reviewed commit with history preserved. Coordinate T08's wizard changes before editing the same behavior. The lead owns shared documents and final local PR drafts.

Read `issues/t15-abr-prerequisites.md` and the recorded acceptance in PRD.md. Implement the prerequisite round trip without changing the user's resource capabilities.

## Required behavior

- An ABR uploader with no local pool explains the prerequisite and offers a path to create a pool.
- Returning from successful pool setup restores the uploader draft and selects that exact compatible pool id. Cancellation also restores the draft. Neither path silently submits the uploader.
- Show remaining pool funding, postage and unknown observations honestly, using T12's existing source of readiness meaning. Do not equate a configured endpoint with confirmed publishing.
- External pools, custom deployments and current group behavior remain available. The proposed navigation names are recommendations for Levi's walkthrough, not authorization to rename or remove capabilities.

Propose the draft handoff, selection identity and observation flow before implementation. The current WizardState contains generated and pasted private keys and SRT passphrases. Keep any retained draft in application memory, not URLs, logs, localStorage or sessionStorage. Clear it on cancellation of the uploader and sign-out. A nested pool flow must not send the uploader's private fields in its own request.

Tests precede fixes. Cover a successful round trip, cancelled pool setup, incompatible or failed pool creation, delayed pool-list refresh, external pools and custom/group access. In the offline browser verify entered uploader fields survive, the intended new pool is selected, remaining blockers are visible, and no implicit uploader submission occurs. Use synthetic fixture data only.

No push, GitHub write, main-v2 merge, host access, live requests, funds or dependency changes. Use owned loopback browser resources with exact cleanup. Any new Docker launch remains subject to the currently pending local-test-container approval and must not bypass it.
