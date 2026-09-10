# Next features, planned 2026-09-05

Status, 2026-09-10. This is the plan as written on 2026-09-05. All four features are built and are
on `feat/ai-remediation` at `6dc33d1`, pull request #40 into `main-v2`, apart from the live engine
status, which is the second pull request of feature 3 and is not started. The stacked branches
this page names are gone. Its decisions D1 to D12 are this page's own numbering and are not the
consensus decisions D01 to D14 in `../consensus/`.

Status: decided 2026-09-05 late evening. Levi took D1 to D11 as recommended and put D12 on
hold, so nothing in swarm-hls-stream changes for now. Building started the same night on stacked
branches, in the order below.

Four features were asked for on 2026-09-05, after the UX rework (PR #39) landed on `main-v2`.
Each has its own brief in this folder. This page is the overview: what each feature is in one
paragraph, the order to build them in, how they become pull requests, and the decisions only Levi
can make. Every PR targets `main-v2` and is squash merged, the branch model set on 2026-09-05.

| # | Feature | Brief | Size | Needs a change in swarm-hls-stream? |
|---|---|---|---|---|
| 1 | Sign in with username and password, then open the manager to the internet | [auth-and-public-access.md](auth-and-public-access.md) | medium, 2 PRs | no |
| 2 | Chequebook on every Bee node: see it, fill it, take money back out | [chequebook.md](chequebook.md) | small, 1 PR | no for the core, yes for sending funds out of a node |
| 3 | SRS and OvenMediaEngine from the UI: settings, restart, logs, live status | [engine-control.md](engine-control.md) | medium, 2 PRs | yes for live status on the current stack, already done on `main-v3` |
| 4 | Several versions of the streaming stack side by side | [stack-versions.md](stack-versions.md) | large, 3 PRs | small, one line in the deploy scripts, plus adopting `main-v3` |

## What each one is

**1. Sign in.** Today the manager has no login at all. It is reachable only through an SSH tunnel
to port 8080 on the host, and its own README says "deploy behind a firewall". Making it public
means three things at once: a login gate in the manager (users, passwords, sessions), HTTPS in
front of it, and closing the other doors on the host. That last part matters more than the login:
every Bee node the manager runs publishes its API on a public port with no authentication, and
that API can spend the node's money. A login on the manager changes nothing about those ports.
The brief covers all three, and the host work is listed as steps for Levi to run, because the host
is a gated deploy.

**2. Chequebook.** A Bee node pays other nodes for forwarding its uploads from a chequebook, a
small on-chain contract funded from the node's own BZZ wallet. When the chequebook is empty the
node still answers its health check and every upload silently stalls, which is exactly what
happened on 2026-08-12. The manager today shows the wallet (xDAI and BZZ) but not the chequebook.
The brief adds the chequebook balance to every Bee node the manager runs, a "Fill chequebook"
action that moves BZZ from the node's wallet into it, the reverse "Withdraw" action, a warning
in the readiness checklist and on the Overview when it runs low, and a refusal to start an
uploader whose node cannot pay.

**3. Engine control.** SRS and OvenMediaEngine (OME) are the media servers that take the SRT
stream from OBS and cut it into HLS segments. Their configuration is generated when the container
starts, from environment variables the manager already writes. The brief adds an Engine card to
the deployment page with the settings that matter (segment length, playlist window, SRT latency,
transcoding knobs), an Apply that recreates the engine with the new values, a Restart, a live
view of what SRS reports (publisher connected, bitrate, viewers), the effective config, and a
log tail. Live status needs the SRS API port, which the current stack does not publish. The
`main-v3` branch of the stack already does, so this ties into feature 4.

**4. Stack versions.** The manager runs one copy of the streaming stack, the git submodule pinned
to `main-v2` at `ee99c36`. Upstream now has `main-v3` with 1095 commits on top, a different port
table, two required secrets and a chequebook floor of its own. The brief lets the manager hold
several named versions (a version is a branch or tag pinned to a commit and built once), lets
each deployment pick one, and reads each version's contract (ports, required secrets, slot cap)
instead of hardcoding it. Versions are named after their branch, as Levi suggested, but pinned to
a commit so a moving branch changes nothing until "Update" is pressed.

## Order

Recommended: 1 (auth) first, because it is the gate for everyone else using the tool and it does
not depend on the stack. Then 2 (chequebook), small and independent, it can even run in parallel
with 1 as a separate PR since it touches different files. Then 3 (engine control) in two steps,
settings and restart first on the current stack, live status once the API port exists. Then 4
(versions), the largest, which also brings `main-v3` in.

## How the work runs

Same as the UX rework. For each PR: this session writes the brief (done), an Opus subagent
implements from it, this session verifies against the mock manager in the Browser pane, then four
review passes (code, TypeScript, React, security), one fix per commit, then the PR against
`main-v2`. Each brief ends with a "Done means" list that the verification follows.

## Open decisions

Each row is something only Levi decides. Decided 2026-09-05: D1 to D11 as recommended. D12 is
on hold, which parks the engine live status backport (D7) and the per version image tag hook
(D9) until it is settled. Everything else proceeds.

| # | Feature | The question, in plain words | Options | Recommendation |
|---|---|---|---|---|
| D1 | auth | How does the manager get HTTPS once it is public? A domain name pointing at the host is needed either way. | (a) Caddy in front of the existing nginx, automatic Let's Encrypt certificates. (b) nginx plus certbot. (c) Cloudflare Tunnel, no open ports but a Cloudflare account dependency. | (a). One small container, certificates renew themselves, one config file. |
| D2 | auth | One shared login or several named users? | (a) Several users, all equal, anyone signed in can add or remove users. (b) One account only. | (a). Same effort, and a leaked password is then one person's to change, not everyone's. |
| D3 | auth | The other public doors on the host (Bee APIs, uploader API, SRS ports). Close them by binding to the Docker bridge and a host firewall, as the brief lists? This is host work that only Levi runs. | (a) Yes, do the host steps in the brief before opening the manager. (b) Open the manager first, close the doors later. | (a). A login on the manager protects nothing if the Bee API next to it takes anonymous withdrawals. |
| D4 | chequebook | Should "Start uploader" refuse when the node's chequebook is below the floor? A written threshold is not a control, only a gate that refuses is. | (a) Refuse with a plain message and a Fill button. (b) Warn only. | (a). Matches what `main-v3`'s uploader does on its own. |
| D5 | chequebook | The floor itself. `main-v3` refuses below 0.5 BZZ available. | (a) 0.5 BZZ, same as the stack. (b) another number. | (a), one number everywhere. Set per host in the manager env, so it can move without a release. |
| D6 | chequebook | "Sending" money out of a node (node wallet to an outside address) needs each node started with a whitelist of allowed addresses, which is a compose change in swarm-hls-stream and a node restart. Wanted now? | (a) Not now: fill and withdraw between wallet and chequebook only. (b) Yes, add the whitelist flag upstream and a Send action. | (a) for this round. It is the one action here that moves money off the host, so it deserves its own review. |
| D7 | engine | Live SRS status needs the SRS API port published per deployment. `main-v2` does not publish it, `main-v3` does (port 10009 plus slot times 10). | (a) Backport that one change onto `main-v2`, small PR in swarm-hls-stream. (b) Wait for feature 4 and show live status only on `main-v3` deployments. | (a). It is about twenty lines and unblocks the most useful half of the card. |
| D8 | engine | OME has a REST API but the stack never enables it. Enabling it means a template change upstream and an access token per deployment. | (a) SRS first, OME gets settings, restart and logs but no live status. (b) Enable the OME API upstream in the same round. | (a). OME is disabled by default in the stack and no deployment uses it today. |
| D9 | versions | Per version image tags need the deploy script to pick up one extra compose file when present, a three line change in `_lib.sh` upstream. Without it two versions rebuild the same `stream-uploader:latest` tag in turn. | (a) Make the upstream change on `main-v2` and `main-v3`. (b) Live with shared tags and serialise builds. | (a). (b) works but wastes a rebuild on every deploy and breaks the moment two deploys overlap. |
| D10 | versions | Where do version checkouts live on the host? Each is about a gigabyte with dependencies and images. | (a) A sibling folder next to the data root, outside the rsynced tree. (b) Inside the repo tree. | (a). The deploy rsync deletes what it does not know, so (b) would wipe them on every manager deploy. |
| D11 | versions | Adopt `main-v3` as a version in this round, with its two required secrets generated per deployment by the manager? | (a) Yes, it is the reason versions are wanted. (b) Versions first with `main-v2` only, `main-v3` after. | (a), as the third PR of the feature, so the first two land on their own. |
| D12 | all | The earlier note "do not modify the swarm-hls-stream submodule" in `docs/features/streamer-stamp-flow.md` was a past session's constraint, and the ABR work already changed upstream. D6, D7, D8 and D9 all touch upstream. Is upstream in scope? | (a) Yes, small contract changes in swarm-hls-stream are fine, PRs there are Levi's to approve too. (b) No, manager only. | (a). Every upstream change here is small and each brief names it. |

D12 stays open. Nothing touches swarm-hls-stream until Levi decides it.

## Housekeeping to fold into the first PR

- The first line of `docs/ux/redesign.md` still says the rework is in progress. It is merged.
- `docs/features/streamer-stamp-flow.md` says the submodule must not change. That is a past
  decision, surfaced above as D12.
