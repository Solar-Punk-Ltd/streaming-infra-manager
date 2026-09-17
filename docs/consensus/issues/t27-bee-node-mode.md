# T27. Choose the Bee node's mode when it starts: ultra-light or light

Source: Levi, 2026-09-17: "start ultra light / light node - choose option during start", the node's RPC endpoint is ours to choose, and a node with a chequebook is funded with xDAI the way the manager already funds. Priority: feature, P2. Depends on: T09 for the funding transactions. Decision: Levi's, the wording below is the proposal to confirm. Size: M.

Today every Bee node the manager deploys runs as a light node: chain backend on, SWAP on, a chequebook deployed on first start, and the RPC endpoint is the stack's default `https://rpc.gnosischain.com` unless the base env says otherwise. On 2026-09-17 the four members of `abr-pool-1` each printed "cannot continue until there is at least min xDAI (for Gas) available" until their addresses were funded by hand.

Bee's two modes, so the choice is named correctly in the wizard:

- **Ultra-light**: SWAP off, no chequebook, no RPC endpoint needed, no gas. The node can only retrieve. It cannot buy a stamp or upload, so it fits a viewer gateway and never a publisher or a pool member.
- **Light**: SWAP on, a chequebook deployed through our RPC endpoint, gas in xDAI and a chequebook deposit and stamps in BZZ. Required for anything that uploads.

Levi's message names the chequebook and the RPC under "ultra light". The register takes that as a slip and puts them under light, which is what Bee does. To be confirmed by him.

## Scope

- The wizard step that creates a Bee node, a pool member or a viewer offers the mode, defaulting to what the role needs: light for publishers and pool members, ultra-light offered for viewer gateways.
- A light node takes the RPC endpoint from the manager's configuration, shown in the wizard, never the stack's public default silently. The endpoint value is a setting, not a secret in the URL, or it is routed the way the manager routes secrets.
- After a light node starts, the funding step offers the gas transfer (xDAI) and the chequebook deposit through the existing transfers, with the node's address and the minimum the node printed.
- The deployment page names the mode, and the readiness rules know that an ultra-light node has no chequebook to check.

## Acceptance

- Creating a viewer gateway in ultra-light mode starts a node that never asks for gas, and its readiness shows no funding step.
- Creating a pool member in light mode starts a node whose RPC endpoint is the manager's, and the funding step shows the node's address and the gas it asks for.

## Where the design lives

The stack's `deploy/docker-compose.yml` Bee services and their `BEE_*` settings, `manager/src/utils/envUtils.ts` (`writeProfileEnv`), the wizard under `frontend/src/forms/wizard`, T09 and T14 in ../PRD.md for the money and stamp flows.
