# fix: save a deployment's notes on their own, without a deploy (T19)

Branch `fix/t19-notes-route`, eight commits on top of main-v2 at d046ebf. Not pushed. Row T19 of the consensus set, see `../issues/t19-notes-without-deploy.md`. Two of the seven are the frontend test runner and its tsconfig split, the same changes as on `fix/t13-srt-default`, cherry-picked so either branch can merge first.

## What was wrong

Notes could only be saved through the PUT that replaces every editable field. That path claims the deployment, asks the uploader gate about the stamp and the node, writes the environment file and starts a deploy, so a note could not be saved while a stamp was invalid or a node was unfunded, and a drawer that loaded before another save could overwrite it.

## What changed

- `PATCH /profiles/:name/notes` writes the notes alone: no claim, no gate, no environment file, no deploy. It answers 200 with the profile, works while a deploy is running, and goes through the normal session and same-site checks like every write.
- `notes_revision` on profiles, migration 013, moves with every change of the notes. The PATCH carries the revision its page loaded and a save whose revision has moved is refused with 409 `notes_conflict`, nothing written.
- The PUT takes the same revision along with an edited note and refuses a stale one before any claim is taken. A PUT without the revision still works the way older clients send it, and a PUT whose note did not change leaves the revision alone.
- The Notes card edits in place and saves through the PATCH. The Edit drawer keeps its path for configuration, sends the revision it loaded along with an edited note, and keeps taking the live value for a note it did not touch.

## Commits

1. `594078b` chore: a node test runner for the frontend's pure modules (shared with T13)
2. `f24e5da` test: saving a deployment's notes on its own, and a stale page refused. Eight of eleven fail on purpose.
3. `f932c99` fix: save a deployment's notes on their own, guarded by the revision the page loaded
4. `7302b46` test: the drawer carries the notes revision it loaded, only with an edited note. One of two fails on purpose.
5. `c2bb72d` fix: the Notes card saves in place without a deploy, and the drawer carries the revision it loaded
6. `7bbb3b0` refactor: keep Node's globals out of the app's typecheck (shared with T13)

## Test evidence

`manager/test/unit/notesRoute.test.ts`, the profiles router on a random port over the in-memory repository and the recording orchestrator:

| # | Guarantee | On the test commit | After |
| --- | --- | --- | --- |
| 1 | The PATCH saves the note, bumps the revision, takes no claim, starts no deploy, leaves the status | fail | pass |
| 2 | null clears the note | fail | pass |
| 3 | It saves while a deploy is running | fail | pass |
| 4 | A stale revision is refused with notes_conflict and nothing changes | fail | pass |
| 5 | Of two saves from the same loaded revision exactly one lands | fail | pass |
| 6 | An unknown deployment answers 404 | pass | pass |
| 7 | A note over 500 characters and a body without the revision answer 400 | fail | pass |
| 8 | The PUT takes the loaded revision and moves it with the note | fail | pass |
| 9 | A stale drawer is refused before any claim, nothing deployed | fail | pass |
| 10 | A PUT without a revision still works | pass | pass |
| 11 | A PUT with an unchanged note leaves the revision alone | pass | pass |

`frontend/src/forms/deploymentEdits.test.ts`: an edited note carries the loaded revision, an untouched note takes the live value and no revision.

Commands: `cd manager && pnpm test` (502 pass), `pnpm typecheck` clean, `cd frontend && pnpm test` (2 pass), `pnpm typecheck` clean. The shared SELECT list test (`profileSql.test.ts`) enforces that the new column is selected everywhere the row is read.

## Review

Reviewed by the TypeScript reviewer agent on 2026-09-08 against the first seven commits: the backend checked out clean (parameter indices, the CASE bump and the revision guard read the old row, 404 and 409 told apart by a re-read, the in-memory fake atomic enough for the concurrent test to mean something). One high finding, taken in the eighth commit: the Notes card read the revision prop at save time, and the event stream moves that prop the moment someone else saves, so a note landing mid edit would have gone through instead of being refused. The card now captures the revision with the draft when editing begins, the way the drawer captures it at open. No test drives the card's save flow, which is a React component. That is the browser check.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock (`mock-manager` without a host passphrase plus the vite dev server), on a throwaway local merge of the T11, T13, T16, T17 and T19 branches, driven by script because the Browser pane was hidden. On main-stage the Notes card's Edit opens the text in place with Save disabled until the text changes. Saving sends `PATCH /profiles/main-stage/notes` (200) and the card shows the new note with the mock's revision at 1. With the card in editing, a second save landed through the API from "another page" (200, revision 2). The card's Save was then answered 409 and the card shows "The notes of main-stage changed since this page loaded. Reload to see them, then save again." under the field, stays in editing, and the other page's note is what is stored. The mock gained the route and the revision rule for this, commit `6b3c50c`.

## Not done here

- Migration 013 has not been run against a database in this session. It is one `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 0`, so existing rows start at revision 0.
- The Notes card was not opened in a browser. Its state logic is small, and the UI check is grouped with the other frontend rows for one browser session.
- The integration suite's `profiles.test.ts` still saves notes through the PUT (without a revision), which keeps working. Nothing here touches the host or any deployment.
