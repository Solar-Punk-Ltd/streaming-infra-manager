# T26. Lists call a reading they never took "Funding not checked"

Source: Levi, 2026-09-17, pictures of the deployments list and the overview. Priority: P2. Depends on: none. Decision: Levi, 2026-09-17: lists take a stamp reading per running Bee node as well, refreshed at most every two minutes, so a standalone node's expired batch is seen again. Size: S.

`readinessOf` builds a checklist with `wallet: null` for every list and the overview, and `fundingStep` turns a missing wallet into the problem "Funding not checked" in the warn state for a running node. The deployments list passes no chequebook reading either. So every running Bee node shows "Funding not checked" on the list, and `needsAttention` counts it, which put all four funded and stamped members of `abr-pool-1` under "Needs attention" on 2026-09-17 while the deployment page of each said "Bee node funded".

## Scope

- The checklist input tells a reading the view did not take (undefined) apart from one the node did not give (null). A list judges funding from the chequebook reading it has, which `useChequebookHealths` already fetches for the overview: a shortfall is a problem, a fine chequebook is funded, a read failure is the failure's own words, and no reading yet is "Reading balances", busy, never a warning.
- The deployments list fetches chequebook readings like the overview does and passes them to its rows and to the "Needs attention" filter.
- "Needs attention" counts a node only for a problem a node reported or a state the manager knows: empty or low chequebook, a stamp problem, a failed deploy, a node that answered with a failure. Never for a reading the page has not taken.
- The deployment page keeps "Funding not checked" for the moment between a start and the node's first answer, which is the one place it is true.

## Acceptance

- Unit tests for `fundingStep` and `readinessOf` with the three wallet values and the chequebook states.
- On the live host, a funded and stamped pool member shows "Node prerequisites checked" on the list and is absent from "Needs attention".

## Where the design lives

`frontend/src/deployments/checklist.ts`, `readiness.ts`, `DeploymentsPage.tsx`, `DeploymentRow.tsx`, `overview/AttentionList.tsx`, T12 readiness and diagnostics in ../PRD.md.
