# T24. The pool string names an address the pool nodes never listen on

Source: the first ABR uploader on a pool on the live host, 2026-09-17. Priority: P1. Depends on: none. Decision: none. Size: M.

Found on 157.90.34.105 at 0696a28. `beePublicApiUrlFor` composes each rung's URL from `PUBLIC_HOST`, so the uploader `abr-pool-stage-1` was handed `http://157.90.34.105:10015` and its three siblings. The T06 firewall design binds a Bee API to the Docker bridge address and to nothing else, and on that host the bridge is 10.200.0.1, so the public IP answers nothing on those ports from the host, from a container or from anywhere. The manager's own probe logged exactly that ("nothing answered at http://157.90.34.105:10015") and the wizard showed it as "Publishing is not verified" for every rung, while the uploader's startup gate hit the same wall and the deploy was refused with `stream-uploader` restarting. The api container reaches the same node through `host.docker.internal`, which resolves to that bridge address. The uploader's compose service carries no `extra_hosts`, so inside the uploader only a literal address works.

The stack's own `BEE_URL` default, `http://bee-uploader:1633`, is the single-node shape and is not affected.

## Scope

- For a pool member the manager deploys on its own host, the URL handed to an uploader is the address a container on that host reaches the node on: `BEE_LOCAL_HOST` when the operator set it, otherwise the address `host.docker.internal` resolves to inside the api container, as a literal, and `host.docker.internal` by name where the manager does not run in a container. A member on a declared remote host keeps that host's address.
- The probe (`publishUrlStateFor`) probes the URL the uploader is handed and no other, so "answers" means the uploader can reach it.
- The wizard's pool checks show the probe's answer per rung instead of the fixed sentence "Publishing is not verified": answers at which address, or did not answer, or not probed.
- `docs/features/abr-ladder.md` and the bind section of `deploy/README.md` say which address the pool string carries and why the public host cannot be it.
- Uploaders created before the fix hold the old string. The pool page's "Copy pool string" now assembles the new one, and pasting it into the uploader's "Node pool string" field under Edit replaces the old. The readiness of such an uploader says so.

## Acceptance

- Unit tests cover the three local shapes (override, resolved literal, bare name) and the remote shape.
- On the live host, `GET /groups/1/bee-publishers` returns every rung with `urlState` ok and a bridge address, and a redeployed `abr-pool-stage-1` starts with the new string.

## Where the design lives

`manager/src/domain/StampService.ts` (`beePublicApiUrlFor`, `publishUrlStateFor`), `manager/src/domain/localHost.ts`, `ProfileService.beePublishersForGroup`, `frontend/src/forms/wizard/steps/PoolPrerequisites.tsx`, T06 in ../PRD.md for the bind design.
