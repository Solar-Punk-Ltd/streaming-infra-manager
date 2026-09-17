# T27. Choose the Bee node's mode when it starts: ultra-light or light

Source: Levi, 2026-09-17: "start ultra light / light node - choose option during start", the node's RPC endpoint is ours to choose, and a node with a chequebook is funded with xDAI the way the manager already funds. Priority: feature, P2. Depends on: T09 for the funding transactions. Decision: settled with Levi on 2026-09-17, see Scope. Size: M.

Today every Bee node the manager deploys runs as a light node: chain backend on, SWAP on, a chequebook deployed on first start, and the RPC endpoint is the stack's default `https://rpc.gnosischain.com` unless the base env says otherwise. On 2026-09-17 the four members of `abr-pool-1` each printed "cannot continue until there is at least min xDAI (for Gas) available" until their addresses were funded by hand.

Bee's two modes, so the choice is named correctly in the wizard:

- **Ultra-light**: SWAP off, no chequebook, no RPC endpoint needed, no gas. The node can only retrieve. It cannot buy a stamp or upload, so it fits a viewer gateway and never a publisher or a pool member.
- **Light**: SWAP on, a chequebook deployed through our RPC endpoint, gas in xDAI and a chequebook deposit and stamps in BZZ. Required for anything that uploads.

Levi's message names the chequebook and the RPC under "ultra light". The register takes that as a slip and puts them under light, which is what Bee does. To be confirmed by him.

## Scope, settled with Levi on 2026-09-17

Levi confirmed the wording above (the light node is the one with the chequebook, our RPC endpoint and gas), and ruled the scope in four points. Funding stays as it is today: the node's page shows the address and the manager moves no money.

1. **Mode chosen at creation.** Every wizard step that creates a Bee node (a stream's own node, a pool member, a viewer gateway) offers a "Node mode" choice: light (chain on, chequebook, can publish) or ultra-light (no chain, no chequebook, download only). Default light for anything that publishes, ultra-light for a viewer gateway, as today. A publisher set to ultra-light is refused in the form with "an ultra-light node cannot upload". The manager writes the mode into the node's settings at deploy.
2. **RPC endpoint chosen at creation.** A light node's step has an "RPC endpoint" field with a choice: the manager's configured endpoint, preselected when there is one, the stack's public default, or an address typed in. The chosen one is written into the node's settings at deploy. An endpoint that carries a key in its URL is a secret: written to the node's settings, never printed in logs or pages.
3. **The page knows the mode.** The node's page shows its mode and endpoint, and an ultra-light node has no funding or stamp steps.
4. **No manager wallet.** Sending gas stays manual, from a wallet outside the manager. A manager-held funding wallet would be a separate money decision and is not part of this row.

## Acceptance

- Creating a viewer gateway in ultra-light mode starts a node that never asks for gas, and its readiness shows no funding step.
- Creating a pool member in light mode starts a node whose RPC endpoint is the manager's, and the funding step shows the node's address and the gas it asks for.

## Where the design lives

The stack's `deploy/docker-compose.yml` Bee services and their `BEE_*` settings, `manager/src/utils/envUtils.ts` (`writeProfileEnv`), the wizard under `frontend/src/forms/wizard`, T09 and T14 in ../PRD.md for the money and stamp flows.
