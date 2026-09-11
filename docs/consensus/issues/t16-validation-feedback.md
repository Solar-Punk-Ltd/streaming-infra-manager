# T16. Make validation feedback consistent and accessible

Source: UX02. Priority: P3. Depends on: nothing. Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`wizardState.ts:314` to :330 `namePreview` returns "Looks good" unconditionally, so an invalid name reads as fine while the action is disabled.

## Scope

- The preview returns the name problem, and the field explanation and the disabled action use the same validation result.
- Name, notes, pool and relevant settings inputs have programmatically associated labels and errors.
- Keyboard operation and focus after a failed submission or step transition work predictably.

## Acceptance

- Invalid names never display Looks good.
- Regression coverage through the actual form for invalid names, duplicate names and malformed pool input.

## Where the design lives

PRD T16 in the task catalog and OpenAI round 2 section 4.

## Code anchors

frontend forms/wizard/wizardState.ts :314 to :330.
