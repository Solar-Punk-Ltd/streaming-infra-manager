# T17. Render endpoints according to their protocol and audience

Source: UX06. Priority: P3. Depends on: T06's contract representation where supplied, not required to start. Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`ContainersCard.tsx:86` links every port as `http://` through `urls.ts:19`, SRT and Bee peer ports included.

## Scope

- A protocol per port key: SRT is UDP, the Bee P2P port is TCP, the APIs are HTTP. SRT and Bee peer endpoints are not hyperlinks. They get copy controls and protocol labels.
- Browser links only for HTTP or HTTPS endpoints. Administrative, internal and public endpoints are distinguishable, and the UI never implies that an intentionally private port opens from the operator's browser.

## Where the design lives

PRD T17 in the task catalog and OpenAI round 2 section 4.

## Code anchors

frontend deployments/ContainersCard.tsx :83 to :94, deployments/urls.ts:19.
