# T13. Give new SRT deployments a safe default

Source: UX01. Priority: P2. Depends on: nothing. Decision: D03 decided. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`wizardState.ts:170` sets `passMode: 'host'` unconditionally, so on a host without a shared passphrase a new SRS stream or ABR uploader defaults to unencrypted ingest.

## Scope

- The default is host when `context.hostPassphrase` exists and generate otherwise.
- D03: the host-wide passphrase stays the default when present, unencrypted ingest stays an explicit expert choice with its warning, existing deployments are unchanged.
- Generated values stay out of logs and test transcripts.

## Acceptance

- On a host without a shared passphrase, a new SRS stream and a new ABR uploader do not default to unencrypted ingest. The test asserts the credential mode actually submitted.
- Review and Publish agree on the selected encryption state.

## Where the design lives

PRD "**T13.**" in Fable round 1 section 5 and OpenAI round 2 section 4, decision D03.

## Code anchors

frontend forms/wizard/wizardState.ts:170, forms/wizard/steps/PassphraseChoice.tsx.
