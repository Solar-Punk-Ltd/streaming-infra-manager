# fix: consistent and accessible validation feedback in the wizard (T16)

Branch `fix/t16-validation-feedback`, nine commits on top of main-v2 at d046ebf. Not pushed. Row T16 of the consensus set, see `../issues/t16-validation-feedback.md`. The first two commits are the frontend test runner and its tsconfig split, shared with T11, T13 and T19.

## What was wrong

The name field said "Looks good" whatever was typed, while the footer next to the disabled Continue named the actual problem, from a separate inline check. The notes and the pasted pool string had no message of their own under the field. None of the three had a label that named its control, so a screen reader announced unnamed text boxes, and a hint or an error was painted but never associated with the field. Moving to the next step left keyboard focus on the Continue button, and a failed submission painted an alert nobody was taken to.

## What changed

- `nameError` and `poolStringError` in `wizardError.ts` carry the answers the footer's checks used inline. The footer and the field read the same function, so they cannot disagree.
- The name, notes and pool string fields show their problem under the field, get an id the label points at, and point `aria-describedby` at the message, which carries `aria-live="polite"` when it is an error. The Edit drawer's notes field gets the same. `FormField` gains `messageIdFor` and an explicit `messageId` for a control inside a choice.
- Each wizard step receives focus on its content unless the step focused a field of its own, and the alert of a failed submission is focused so it is read out.

## Commits

1. `3f7ecb4` chore: a node test runner for the frontend's pure modules (shared)
2. `c64c826` refactor: keep Node's globals out of the app's typecheck (shared)
3. `f1d3821` test: the name and the pool string are judged once, for the field and for the footer alike. Fails to load on purpose.
4. `ebb8fba` fix: the name and the pool string are judged by one function each, for the field and the footer
5. `8bc28bb` fix: the name, notes and pool string say what is wrong under the field, with labels a screen reader reads
6. `5318082` fix: each wizard step and a failed submission land focus where the keyboard needs it

## Test evidence

`frontend/src/forms/wizard/wizardError.test.ts`, seven tests, `cd frontend && pnpm test`: an invalid name gives the same answer under the field and in the footer, a taken name says taken in both places, an empty name asks for one, a pool name is held to the room its rungs need, a good name has nothing said, a malformed pool string gives the same answer in both places, an empty pool string says nothing under the field. `pnpm typecheck` clean at every commit.

## Review

Reviewed by the React reviewer agent on 2026-09-08 against the first six commits: two high findings, three medium, all taken:

- `ae54699` fix: the message element a control points `aria-describedby` at is always on the page once it has an id, empty when there is nothing to say, so the reference never dangles and the live region is one screen readers already know. The pool choices are a `radiogroup` named by the question's label through `aria-labelledby`.
- `1adc9d1` fix: the focused step container shows a focus ring on focus-visible instead of switching its outline off, and a repeated failure with the same words is reached again, since the effect keys on a count of failures rather than the text.
- `2ad79ea` test: the empty name and the empty pool string are asserted where they are shown, in the footer.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock (`mock-manager` without a host passphrase plus the vite dev server), on a throwaway local merge of the T11, T13, T16, T17 and T19 branches, driven by script because the Browser pane was hidden. Typing "Bad Name" shows "Name: lowercase letters, digits and dashes, max 31 characters" under the field and the same text in the footer, the input carries `aria-invalid="true"` and `aria-describedby="wizard-name-message"`, and Continue is disabled. Typing the name of an existing deployment shows "That name is taken" in both places. A good name shows "Looks good" and enables Continue. The notes field is described by a message element that is present even while empty. On arrival at the Basics step focus is in the name field, and on arrival at the Settings and Review steps focus is on the step container. In the ABR uploader flow the pool choices are a radiogroup labelled "Node pool to publish to", the pasted pool field is described by its message, a malformed string shows "Pool string: expected space-separated rung@http://host:port<batchid> entries, as copied from an ABR node pool" under the field and in the footer with Continue disabled, and an empty string leaves the field message empty while the footer asks for the string.

## Not done here

The label, described-by and focus wiring is React and has no unit test. That is the browser check, grouped with T13, T17 and T19 on the offline mock, where invalid and duplicate names and a malformed pool string are tried through the actual form with the keyboard. Nothing here touches the host or any deployment.
