# fix: OvenMediaEngine files are parsed strictly, held to the template's contract, and described honestly (T03)

**T11 integration correction, 2026-09-08:** the literal-value XML validation below is implemented, but the test that calls missing-placeholder detection does not prove the claimed file-source display. T11 must still distinguish a parsed literal from an omitted directive. See `../T11-CONTINUATION.md`. This is accepted scope, not an optional wording decision. The recorded local arm64 engine results remain historical evidence, not a new Codex run.

Branch `fix/t03-ome-xml`, seventeen commits on top of `fix/t01-config-ownership` at 3dbf660. Not pushed. Row T03 of the consensus set, see `../issues/t03-ome-xml-validation.md`. Stacked on T01 because the watch after the recreate and the rollout states the card shows are T01's, so merge T01 first. One new dependency, `saxes`, with the provenance record below.

## What was wrong

The OvenMediaEngine check was a regex tag balance scan, so a second root element, an entity XML does not define or an attribute without quotes passed it. The one element it required, the admission webhook block, was checked by name only, and nothing held the file to what the stack's uploader depends on: the callback route, the secret, the bind ports, the applications and their stream names. The config dialog claimed "the engine's own parser" for both engines, which is true for SRS only. The stack runs `airensoft/ovenmediaengine:latest`, an unpinned tag.

OvenMediaEngine's own loader turned out to be lenient. Checked on 2026-09-08 against v0.21.0: it starts on a file with a second root element and on one with an undefined entity, reading past both silently, and exits only on the unquoted attribute. So the engine cannot be the gate for a malformed file. The manager has to be.

## What changed

- A strict parser over `saxes` replaces the scan. A second root, an undefined entity, an unquoted attribute, a bare `<` and text outside the root are refused with their line, a mismatched closing tag names the element it does not match, and an element left open names its line. Comments, CDATA and the declaration pass.
- The contract is derived from the version's own template by path, applications told apart by their name. Protected, with the template's value: every element whose text carries a placeholder that no drawer field maps to (the callback URL, the secret), every bind port, admission enablement, every application's name, what each application provides and publishes, and its stream name mapping. Tunable: the two placeholders the drawer fills, segment duration and count, may stay placeholders or become literals that pass the field's own range, and T11 then reports the setting as controlled by the file through the existing "not in the file" reading. Sibling order is free and anything else may be added. The missing admission element is now a contract refusal like any other.
- The checker takes the version's template along with the file, so a version that changes its template changes the contract the day it is built.
- After the recreate, for OvenMediaEngine only, the manager tries the HLS port the slot publishes on once the twenty second watch is over, for ten seconds more, through the same host it reaches every published port on. A port that answers is liveness, not a verdict on the file. One that does not leaves a note on the applied rollout naming the port, shown by the card and the dialog as a diagnosis, and reverts nothing: the engine is up, and the file may be what it is meant to be. SRS, whose parser was asked before anything changed, is never probed.
- The dialog says what applying does per engine. SRS: its own parser first, in a throwaway container, so a refused file changes nothing. OvenMediaEngine: the manager's check first, well formed XML that keeps what the uploader depends on, then the recreate, the watch and the port, with the previous file coming back as a recovery attempt and not a promise, and an unanswered port as a note rather than a failure.
- The integration gate, `manager/test/docker/ome-admission-gate.sh`: the pinned image and this stack's template, rendered by this stack's entrypoint, on a private Docker network with a fake uploader that answers the admission webhook the way the stack's uploader does, signature checked. An SRT publisher of a generated picture and tone must be admitted through a signed opening call, a media playlist with a segment must appear on the port and path the uploader polls, and a closing call must follow the publisher's end. No funds, no Swarm, no host.

## The pinned pair (N01)

`latest` resolved on 2026-09-08 to `v0.21.0`, manifest list `sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6` (amd64 `sha256:c77bb2b090209b73b35f355a4dd63d624f3e97b29b9de7a69dda5c49e0525240`, arm64 `sha256:1323385441f031fdfbbb74bc2ea610586ca4c73699999afadbd6a9702d86bcd1`), pushed 2026-08-13. Run locally on arm64 with this stack's template and entrypoint, no network, bounded to 25 s each:

| File | Outcome |
| --- | --- |
| The template as it is, the healthy control | running after 29 s, "All modules are initialized successfully", SRT listening |
| A second root element appended | running after 29 s, the engine reads the first root and says nothing |
| An entity XML does not define in the server name | running after 29 s, the engine says nothing |
| The root's version attribute without quotes | exit 1 after 3 s, "An error occurred while load config: [Config] Could not read the file" |

The healthy control also passed the integration gate above, with two segments in the media playlist, a signed opening call and a closing call for `video/gate`.

The stack change is yours to commit in swarm-hls-stream, `deploy/docker-compose.yml` line 165:

```yaml
    image: airensoft/ovenmediaengine:v0.21.0@sha256:172da9129d32093f3c92c426d385a318db38c7e70de0a3a685693e69614672a6
```

Nothing was pulled or run on the host.

## Dependency provenance

`saxes` 6.0.0, published 2021-11-07, its one dependency `xmlchars` 2.2.0 published 2019-09-06. Both carry a verified registry signature. Neither carries a provenance attestation, which predates both publishes, recorded here as missing. `npm audit signatures` over the installed tree verified every package's registry signature. The GitHub advisory database lists no advisory of any kind for either, malware included. The alternative `fast-xml-parser` carries a provenance attestation but twelve past advisories and a release twelve days old at the time, so the older strict parser was chosen. Added with the pinned pnpm 11.10.0, so the lockfile is in its own form.

## Commits

1. `f97ce54` chore: saxes 6.0.0, a strict XML parser for the OvenMediaEngine config check
2. `3eaaaa1` test: OvenMediaEngine files are parsed strictly and checked against the contract the version's template sets. The contract test fails on a missing module, five of the check tests fail on purpose.
3. `77a1890` fix: OvenMediaEngine files are parsed strictly and held to the contract the version's template sets
4. `380a0e0` test: the HLS port is tried after an OvenMediaEngine file applied, as a diagnosis, and the card shows the note. Two of three and two of nine fail on purpose.
5. `bd82faf` feat: the HLS port is tried after an OvenMediaEngine file applied, as a diagnosis and never a verdict
6. `78dcdba` feat: the card and the dialog show the note an applied rollout carries
7. `a1976f5` fix: the config file dialog says what applying does per engine, without promising a recovery
8. `d215233` feat: the mock plays an applied rollout with the note an unanswered HLS port leaves
9. `c48a692` test: the OvenMediaEngine integration gate, SRT in, signed admission out, HLS playlist served, with a fake uploader and no funds
10. `9f35bd6` test: the watchers of the older service tests answer the probe, and their timing carries its budget

Commits 5 to 9 leave the manager's typecheck red on two of T01's test files, whose scripted watchers had not learned the probe. Commit 10 is that omission, and the branch typechecks from there. The unit suite passed at every commit because the watchers of those tests are never asked about a port.

## Test evidence

`manager/test/unit/omeContract.test.ts`, seventeen tests over the stack's template copied into `test/support/omeTemplate.ts`:

| # | Guarantee (acceptance line) | On the test commit | After |
| --- | --- | --- | --- |
| 1 | The template keeps its own contract | fail | pass |
| 2 | Applications and the blocks inside one in another order keep it | fail | pass |
| 3 | More than the template has is allowed | fail | pass |
| 4 | Comments and CDATA are read through | fail | pass |
| 5 | A changed callback route with every placeholder in place is refused, naming ControlServerUrl | fail | pass |
| 6 | The secret placeholder made a literal is refused | fail | pass |
| 7 | A removed bind port is refused, naming it | fail | pass |
| 8 | Admission enabled for another provider is refused | fail | pass |
| 9 | A renamed application is refused, naming video | fail | pass |
| 10 | An application without the template's provider is refused | fail | pass |
| 11 | A changed stream name mapping is refused | fail | pass |
| 12 | A file with no admission element is refused | fail | pass |
| 13 | The segment duration as a literal in range is accepted, and T11 reports it as controlled by the file | fail | pass |
| 14 | A literal outside the range is refused, naming the range | fail | pass |
| 15 | A count that is not a whole number is refused | fail | pass |
| 16 | A literal that is not a number is refused | fail | pass |
| 17 | The setting removed from one application only is refused | fail | pass |

`manager/test/unit/engineConfigCheck.test.ts`, the OvenMediaEngine block: the template passes without a command runner, a second root, an undefined entity and an unquoted attribute are refused with their line, a mismatched closing tag names the element and its line, an element left open is named, comments and CDATA and the declaration pass, a bare `<` says how to write one, a changed admission route is refused before anything runs, and the literalised segment duration passes. Five failed on the test commit.

`manager/test/unit/omeLiveness.test.ts`: the HLS port of the slot is tried once the watch is over, within the budget, and an answer ends the rollout applied with no note. No answer ends it applied with a note naming the port and reverts nothing. An SRS deployment is never probed. Two of three failed on the test commit.

`common/src/engineConfigRollout.test.ts`: an applied rollout with a note shows it as a diagnosis, and every state has an answer.

Commands at the head: `cd manager && pnpm test` (543 pass), `cd common && pnpm test` (270 pass), `pnpm -r typecheck` clean across the workspace, `bash manager/test/docker/ome-admission-gate.sh` passed on 2026-09-08 (engine up, two segments, signed opening and closing calls).

## Review

Reviewed by the React reviewer agent on 2026-09-08 against the first nine commits, in its own worktree with its own install (pnpm 11 through corepack). Nothing high in the diff itself. Two medium findings and two low ones, all taken:

- Medium: the mock produced the HLS port note for any engine, where the manager leaves it to OvenMediaEngine. Commit 11 gates it the same way.
- Medium: the shared module's header still said the row's reason is why a rollout did not end applied, which this branch widens. Commit 12 says so in the header and on the row type.
- Low: the SRS copy did not call the previous file coming back a recovery attempt the way the OvenMediaEngine copy does. Commit 13 does.
- Low: the same stale comment on the frontend row type, taken with commit 12.

The reviewer traced that a note can never be paired with an older rollout's state: the manager writes the state and the reason in one statement and the frontend replaces whole rows, never fields. It checked the per-engine copy against what the manager does, line by line, the exhaustive engine record, the dialog's fallback before the live row is known, and the style rules. It flagged that the repository has no ESLint at all, a standing gap this branch did not open, and saw the two T01 test watchers failing the manager's typecheck at commit 9, which commit 10 fixed.

Reviewed by the TypeScript reviewer agent on 2026-09-08 against the first nine commits, in its own worktree with its own install, the manager suite, both typechecks and the shared package's suite run, the gate script read. One critical finding, taken, one high finding already fixed by commit 10, six medium findings, five taken and one kept by design, and four low ones, three taken and one noted:

- Critical: a file that duplicated a protected element passed the contract beside a faithful copy, because the check only asked whether the template's value was somewhere at the path. The reviewer proved it with two files: a second application named video with a changed stream name and no provider, and a second virtual host with no admission block, which would admit publishers past the uploader. Commit 15: every element that names itself is keyed by its name, every container the contract goes through must appear exactly as often as in the template, every value at a protected path must be the template's, a virtual host the template does not have is refused, and an application or host without a name is refused. A second output profile with a name of its own stays allowed. Tests in commit 14.
- High: the manager's typecheck failed on two of T01's test watchers at the commit reviewed. Commit 10, already on the branch, is that fix.
- Medium: a literal in place of a drawer placeholder was checked by a looser rule than the drawer's, so 1e1, 0x10, +5, 5.0 and seven fraction digits passed here and not there. Commit 15 checks by the drawer's own rule, and names an empty literal as empty.
- Medium: the applied rollout's note lives in the row's error column. Kept: T01 named the column before this branch, the shared notice reads it with the state, and a rename is its own change.
- Medium: an application without a name collapsed into a shared path. Commit 15 refuses it.
- Medium: no test for a version whose port table publishes no HLS port. Commit 14 adds it, the code already skipped cleanly.
- Medium: the gate started the fake uploader and the publisher with no readiness check, and started a container for every poll. Commit 17 polls the uploader until it answers, requires the publisher to still run five seconds in, and polls from one long-lived busybox.
- Low, taken: an empty literal produced a message with two spaces (commit 15), the two parser fallbacks saxes reaches first were dead (commit 16), an empty secret and one inconsistent poll in the gate (commit 17).
- Low, noted: none left.

The reviewer traced the parser's recovery after an error, confirmed the first error wins and the tree is discarded, checked the mismatched-close element, the probe's socket lifecycle and budget arithmetic, the COALESCE semantics between Postgres and the fake, the local host extraction, the dependency provenance and the gate's signature check, and found them sound.

Additional commits from the two reviews:

11. `13d0b29` fix: the mock leaves the HLS port note to OvenMediaEngine, as the manager does
12. `579c978` docs: the row's reason can also be a note from a check that ran after an apply
13. `0c60b56` fix: the SRS dialog copy calls the previous file coming back a recovery attempt too
14. `cf821be` test: a duplicate of a protected element cannot pass beside a faithful copy, literals are shaped as the drawer shapes them, and a version without an HLS port is not probed. Six of the new tests fail on purpose.
15. `d754687` fix: a duplicate of a protected element cannot pass beside a faithful copy, and literals are shaped as the drawer shapes them
16. `228aa25` refactor: drop the parser's two fallbacks saxes reaches first
17. `be10c3b` fix: the gate waits for the fake uploader, checks the publisher took, and polls from one container

Commands after commit 17: `cd manager && pnpm test` (551 pass), `pnpm typecheck` clean, and `bash manager/test/docker/ome-admission-gate.sh` run again locally on 2026-09-08: fake uploader up, engine up, publisher running, one segment in the media playlist within the window, a signed opening call and a closing call for `video/gate`, PASS on the pinned digest.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock plus the vite dev server, driven by script because the Browser pane was hidden.

- A file that says `note` on backup-stage: the card went through "Verifying: SRS 6 is watched for a while..." and ended with "Applied, with a note from the check that ran after it." followed by the note naming the port, the deployment still on its own file.
- A deployment created on main-v3 with the OvenMediaEngine engine: its card says OvenMediaEngine, and its config file dialog reads "OvenMediaEngine has no parser to ask, so applying checks the file here first: it must be well formed XML and keep what the stack's uploader depends on from this version's template. Then the engine is recreated on it, watched for twenty seconds, and its HLS port is tried once the watch is over. If the engine will not stay up the previous file comes back on its own, which is a recovery attempt and not a promise, and a port that does not answer is reported as a note, not a failure. A publisher, if one is live, is disconnected for a few seconds either way."
- The SRS deployment's dialog reads "Applying runs the file through SRS's own parser first, in a throwaway container, so a file it refuses changes nothing. Then the engine is recreated on it and watched for twenty seconds, and if it will not stay up the previous file comes back on its own. A publisher, if one is live, is disconnected for a few seconds either way."

## Questions for Levi

- The image pin is your commit in swarm-hls-stream. The line is above. The manifest list digest covers amd64 and arm64, and the host is amd64. Say if you want the amd64 digest pinned instead.
- The integration gate needs the stack submodule, which the checks workflow does not check out. It belongs in T20's Docker job with `submodules: true` on its checkout step, which is a one line change on `fix/t20-ci-checks`. Say if you want it there now or with T20's next round.
- The contract's path set is derived from the template, so a later version that adds a protected element to its template protects it without a manager change. A version that removes one relaxes it the same way. That is by design, said here so it is not a surprise.
- T11's "not in the file" wording is what reports a literalised setting as controlled by the file. It is truthful, the placeholder is not in the file. Say if you want a different word for the literal case.
- The dialog and the card copy are mine. Change any wording you like, the tests match on fragments.

## Not done here

- The gate ran locally on arm64. The host and the Docker job are amd64, where the same digest resolves to the amd64 image.
- Nothing here touches the host, any deployment, or any credential.
