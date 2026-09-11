# fix: a new deployment on a host without a shared passphrase gets one of its own (T13)

Branch `fix/t13-srt-default`, five commits on top of main-v2 at d046ebf. Not pushed. Row T13 of the consensus set, see `../issues/t13-srt-default.md`. Decision D03 applied as decided.

## What was wrong

The wizard started every new stream and ABR uploader on "Use the host-wide passphrase" (`wizardState.ts`, `passMode: 'host'`) whether the host had one or not. On a host without a shared passphrase that default is unencrypted ingest, and a default is what most deployments keep. The Review step then said "the host-wide passphrase" on such a host, while the Publish card afterwards said the ingest was unencrypted.

## What changed

- `defaultPassphraseChoice(context)`: the host-wide passphrase when the host has one, a generated one when it has none. `initialWizardState` uses it, so a goal change keeps it too. What the wizard submits follows: `chosenPassphrase` is the generated one, which `sharedBody` in `wizardSubmit.ts` sends as `srt_passphrase`.
- The host-wide choice stays offered on every host, with the existing warning ("The host has no shared passphrase, so this would publish unencrypted."). Unencrypted ingest is an explicit choice, never a default. Existing deployments are untouched.
- `passphraseSummary(state, context)` moves from the Review step into `wizardState.ts` next to the choice it describes, and says "none, this host has no shared passphrase, so the ingest is unencrypted" when the host-wide passphrase is chosen on a host without one, which is what the Publish card says afterwards.
- The frontend gains a test runner: `pnpm test` in `frontend/` runs `src/**/*.test.ts` under node:test through tsx. tsx 4.19.2 and @types/node 22.9.0 are the versions the manager already resolves, so no new package version enters the lockfile. `types: ["vite/client", "node"]` in the frontend tsconfig, typecheck clean.

## Commits

1. `7628812` chore: a node test runner for the frontend's pure modules
2. `d89f2e1` test: the passphrase a new deployment starts with, on a host with one and without. Three of four fail on purpose.
3. `554e31b` fix: a new deployment on a host without a shared passphrase gets one of its own
4. `e4b8f60` test: what the Review step says about the passphrase, host by host. Fails to load on purpose.
5. `6e564e1` fix: the Review step says the ingest is unencrypted when the host-wide passphrase is chosen on a host without one

## Test evidence

`frontend/src/forms/wizard/wizardState.test.ts`, run with `cd frontend && pnpm test`:

| # | Guarantee | Before the fix | After |
| --- | --- | --- | --- |
| 1 | With a host-wide passphrase the default is host, and null is submitted (the host-wide one) | pass | pass |
| 2 | Without one the default is generate, and the generated passphrase is what is submitted | fail, passMode host | pass |
| 3 | The same for an ABR uploader | fail | pass |
| 4 | A change of goal keeps the safe default | fail | pass |
| 5 | Review names the host-wide passphrase when the host has one | load failure | pass |
| 6 | Review says unencrypted when host-wide is chosen on a host without one | load failure | pass |
| 7 | Review says generated, and your own | load failure | pass |

7 tests pass. `pnpm typecheck` in `frontend/` clean at every commit.

## The lockfile

The two frontend entries were written by hand in the form pnpm 11.10.0 (the pinned `packageManager`) writes them, because the machine's pnpm is 9.12.0 and rewrote unrelated lockfile settings, and corepack's pnpm 11 could not resolve offline. `pnpm install --frozen-lockfile --offline` answers "Already up to date" on the result, and `git diff` shows the six added lines and nothing else. No package was downloaded and no new version was introduced, so the provenance checks the repository requires for a new version do not apply. If you prefer pnpm 11 to write the lines itself, `corepack pnpm install --lockfile-only` online should produce the same six lines.

## Review

Reviewed by the TypeScript reviewer agent on 2026-09-08 against the first five commits: no critical or high findings, two medium, two low. All four taken:

- `fa39c51` refactor: Node's globals leave the app's typecheck. The app tsconfig is back on `vite/client` alone and leaves the test files out, `tsconfig.test.json` checks the tests with Node's types on top, and `pnpm typecheck` runs both. The same commit is carried on `fix/t19-notes-route`, which shares the runner.
- `8e29d70` test: the goal-change case is named for what it checks, that the default is recomputed from the host when a change of goal starts the settings over, since a manual choice does not survive one by design. The file header covers both suites.
- `ff74c7c` fix: the Review line reads "none on this host, so the ingest is unencrypted", one phrase like its siblings.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock (`mock-manager` without a host passphrase plus the vite dev server), on a throwaway local merge of the T11, T13, T16, T17 and T19 branches, driven by script because the Browser pane was hidden. On a host without a shared passphrase, a new Stream and a new ABR uploader both arrive on the settings step with the generated passphrase selected (`wizard-passphrase=generate` checked), and the Review step's SRT passphrase row reads "generated for this deployment". The host-wide choice stays offered. The mock gained `MOCK_HOST_PASSPHRASE=''` for this, commit `0a0aebc`.

## Not done here

The wizard was not opened in a browser for this change. The default and the Review wording are unit-tested at the state level, and the UI check is grouped with the other wizard rows (T16, T17) for one browser session. Nothing here touches the host or any deployment.
