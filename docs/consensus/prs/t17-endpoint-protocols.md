# fix: endpoints rendered by protocol and audience (T17)

Branch `fix/t17-endpoint-protocols`, seven commits on top of main-v2 at d046ebf. Not pushed. Row T17 of the consensus set, see `../issues/t17-protocol-aware-endpoints.md`. The first two commits are the frontend test runner and its tsconfig split, shared with T11, T13, T16 and T19.

## What was wrong

The Containers card linked every published port as `http://host:port`: the SRT ingest listener, the Swarm peer port and the Bee and uploader APIs kept behind the firewall, alike. A link says the address opens in the operator's browser, which is false for the first two and misleading for the APIs.

## What changed

- `endpoints.ts`: `endpointKindOf(portKey)` reads the protocol and the audience off the key the stack's port table uses. SRT is UDP ingest, RTMP is TCP ingest, a P2P port is for Swarm peers, an API port is HTTP for the operator's tools, the client port is the viewer page, an HTTP or HLS port is the engine's output for the stack's own containers, and an unknown key is a plain TCP port that claims nothing. Only the viewer page opens in a browser. `endpointAddress` writes `srt://`, `rtmp://`, `http://` or a bare `host:port` as the tool for that protocol takes it.
- The Containers card links the viewer page alone. Every other port shows its number, its protocol and audience in words, and a copy control for the address.
- When T06 gives the version's port contract a protocol per port, the kind can come from there instead of the key.

## Commits

1. `c4de98f` chore: a node test runner for the frontend's pure modules (shared)
2. `8e1b453` refactor: keep Node's globals out of the app's typecheck (shared)
3. `8df2a39` test: what a port is, read off its key, and which one a browser may open. Fails to load on purpose.
4. `4fef5ec` fix: a port knows its protocol and audience, and whether a browser may open it
5. `a32108f` fix: the Containers card links only the viewer page, and says what every other port is for

## Test evidence

`frontend/src/deployments/endpoints.test.ts`, eight tests, `cd frontend && pnpm test`: SRT is UDP ingest and no page, a peer port is for nodes, the three API keys stay off the browser, the viewer page is the one link, HLS output is internal, RTMP is TCP ingest, an unknown key claims nothing, and the three audiences are told apart in the label. `pnpm typecheck` clean.

## Review

Reviewed by the React reviewer agent on 2026-09-08 against the first five commits, every real port key checked against the rule: two high findings, two medium, one low, all taken:

- `af27f94` fix: the copy button builds "copy ..." from its label itself, so the cell read "copy Copy http://...". The label is the bare address now. The viewer link says what it opens. Each port takes two lines instead of wrapping mid row.
- `7354bfe` test: the RTMP case is named for what it asserts, and the docstring says the API check comes before the HTTP one on purpose.

## Browser check

Checked on 2026-09-08 in the app served by the offline mock (`mock-manager` without a host passphrase plus the vite dev server), on a throwaway local merge of the T11, T13, T16, T17 and T19 branches, driven by script because the Browser pane was hidden. On the stream main-stage the Containers card shows `SRS_SRT_PORT 10011, SRT ingest, UDP, public`, `API_PORT 10010, API, HTTP, administrative`, `BEE_UPLOADER_API_PORT 10015, API, HTTP, administrative` and `BEE_UPLOADER_P2P_PORT 10016, Swarm peers, TCP and UDP, public`, none of them a link, each with a copy button labelled `copy srt://lab-host-1:10011`, `copy http://lab-host-1:10010` and so on. On the viewer viewer-eu the client port is the one link, `http://lab-host-1:10044`, with the accessible name "Open http://lab-host-1:10044, the viewer page, HTTP, public", and the gateway's API and peer ports are labelled and unlinked.

## Not done here

The card is React and has no unit test. The browser check is grouped with T13, T16 and T19 on the offline mock. Nothing here touches the host or any deployment.
