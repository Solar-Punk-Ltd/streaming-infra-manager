# SRS continuation media test environment

Status: active preparation under R09 of the registered SRS continuation plan. No assembled media fixture has run yet.
Date: 2026-09-21.
Owner: OpenAI-hosted Astra.

## Corrected prerequisite

The reviewed plan names a disposable Bee in dev mode. That environment assumption is obsolete for the selected Bee 2.8.2. The official [Bee 2.8.1 release notes](https://github.com/ethersphere/bee/releases/tag/v2.8.1) say the dev command was removed and direct local development to Bee Factory or testnet. This was checked on 2026-09-21. It is a test-fixture correction, not a reason to use funded live nodes or silently downgrade Bee.

The candidate replacement is an isolated private-chain arrangement, using pinned Bee Factory artifacts where they meet the version and isolation requirements. [Bee Factory](https://github.com/ethersphere/bee-factory) provides Bee nodes and an Anvil test chain. Its current source was read at `4c2c91203b4d10fff33a2ae61ee6b48a00341f1e` through the GitHub API. An older cached web view still called the repository archived, so the exact API source is the basis for this preparation.

Do not execute the upstream start or stop command against the shared daemon. Its [Docker helper](https://github.com/ethersphere/bee-factory/blob/4c2c91203b4d10fff33a2ae61ee6b48a00341f1e/src/docker/manager.ts) uses shared container names, prefix cleanup and public port binds. Its [startup command](https://github.com/ethersphere/bee-factory/blob/4c2c91203b4d10fff33a2ae61ee6b48a00341f1e/src/commands/start.ts) can build a moving source ref and prints development wallet keys. No such command has been installed or executed for this task.

P1. Using the old fixture recipe would certainly fail before testing, and running the replacement's raw cleanup could remove a neighboring fixture. Adapt the narrow orchestration into this task's isolated harness. The cost is fixture setup and pinned-image verification. Accepting the unmodified commands risks other work and invalid evidence.

### Available matching image candidates

Docker Hub's public tag API returned all six `v2.8.2` images on 2026-09-21. They were published on 2026-08-26, outside the fourteen-day freshness flag. The following linux/amd64 manifest digests match the push lines in the successful [official image build 32947067964](https://github.com/ethersphere/bee-factory/actions/runs/32947067964). That build names `--tag v2.8.2` and source commit `4c2c91203b4d10fff33a2ae61ee6b48a00341f1e`. GitHub reports the source commit's signature verified.

| Image under `docker.io/ethersphere/` | linux/amd64 manifest digest |
| --- | --- |
| `bee-factory-blockchain` | `sha256:d63e15b7e5e71159a23a09835f89ba46913d4ba3fb8dd31b90ceaca2e9363d08` |
| `bee-factory-queen` | `sha256:60bf85b9938da1c9309dd8bb9c0b691963d30338fa2c5d7e75d7a012fdaa5ab4` |
| `bee-factory-worker-1` | `sha256:14711443c3de2bae815b7e545b7c6863d397f5ea3527d7490b80ffdd165c631a` |
| `bee-factory-worker-2` | `sha256:45ee131a0a53f84ded6c0d57ed74be9dc4b0d8236eb7a9ece9b4a4adb257fd55` |
| `bee-factory-worker-3` | `sha256:3d67f8f183f6b15d561cc3d1cebf8ee4c008cfa9c1d9d2e6b345e006bb8e8a64` |
| `bee-factory-worker-4` | `sha256:d773d6e0ef3a22b71d8f22d5e9780e66cff4517d1a420a38e09a404a2b621633` |

This establishes the published source/build association, not an independent image signature, installed-package audit or successful runtime. Those checks and the actual binary version remain pending. No image was pulled for this preparation. The images contain public disposable development identities and chain snapshots. The harness must neither print those identities' private material nor use them on a real network.

## Required arrangement

The harness belongs to the stack repository and accepts exact stack, admin and manager candidate identifiers. It uses the approved host `157.90.34.105`. The existing task database remains separate until its current focused checks finish.

Use one randomly suffixed project identity beneath `/home/solarpunk/srs-continuation-tests-20260920/`. Every container, network, volume and output directory must carry that identity. Persist the exact resource IDs created by the harness. Refuse a pre-existing object with the same name instead of adopting it. Cleanup addresses only those recorded objects after checking their identity label. No daemon prune or prefix-based removal is permitted.

The media arrangement contains SRS, the candidate uploader, the candidate admin API and disposable Postgres, the candidate bundled viewer, a private chain and isolated Bee storage. The browser and synthetic media sender run beside them. All use the private test network. Publish only the explicitly selected browser/control endpoints on loopback after collision checks. Do not borrow a live API, gateway, RPC endpoint, volume, signing identity or postage batch.

Record immutable image digests and actual executable versions. Bee Factory development images may contain a reachability override, so record that difference rather than calling them identical to production. Prefer exact Bee 2.8.2 where supported. A missing matching artifact is an unmet prerequisite to resolve, not permission to substitute a version silently. Any image or package introduced by the fixture receives the normal provenance checks before execution.

The private chain has no bridge to Gnosis and uses disposable public development identities only. Verify chain identity and internal endpoint ownership before any test-chain funding or postage call. These simulated transactions do not establish real Swarm readiness or authorize any real-wallet transaction. Application tokens for this fixture are isolated test values and must never be confused with live references.

## Preflight and observations

Before a media sender can start, require all of the following in one refusing preflight:

- Every component answers at its expected identity and version. The admin reports the intended capability and enrollment assignment.
- The private chain answers on the isolated network with the expected chain identity. No configured RPC or Bee URL points to a live or public service.
- Test storage has a usable test batch, enough capacity and lifetime for the bounded scenario, and a successful upload/read control through the actual configured read path.
- SRS callbacks reach the candidate uploader. The immutable opening-format tool is present and a known fixture is parsed correctly.
- The browser actually decodes the selected video/audio codecs. A false codec control must be refused. A mounted video element is not decoding evidence.
- Disk, memory and process limits can accommodate the scenario. The harness records its CPU/memory limits, co-tenants and timeout bounds.

Capture complete metrics and statistics from every test service before and after each scenario, with complete bounded test logs and exit codes. Diff the entire metric surface. Report missing instruments explicitly. Do not read or archive live container environment values. Read-only host co-tenancy inventory need not include secrets or funded-node API responses.

## Scenario sequence

| Stage | Required scenario | Evidence that distinguishes success |
| --- | --- | --- |
| Protocol | Existing RTMP/SRT source and one-rung probe, then the pending late-first-rung probe | Real connection identifiers, callback order, busy refusal and forced disconnect. The pending probe has no result yet |
| First recording | Publish labeled A, stop, wait beyond the original sixty-second deadline | Closed ingress, complete replay, exact accepted segments and a refused same-ID restart |
| Grace | Stop/reconnect under the original deadline using labeled A and B | Same run and history, no early end marker, one marked seam, decoded A then B |
| Continue twice | Finish A, explicitly Continue B, then Continue C with fresh uploader processes | One cumulative A+B+C replay. Old captured snapshots remain byte-stable and playable. Prior media is not uploaded again |
| ABR | Repeat grace and continuation with every configured rung, then lose one rung | Source deadline is independent of rung health. Missing expected rung prevents false complete VOD. Every pinned quality decodes |
| Crash and overlaps | Kill the uploader around durable acceptance, cutoff, final publication and preparation. Keep SRS alive for a separate restart case | Original cutoff survives. Exact source and rung bindings recover. No duplicate or lost accepted footage. Competing writer is refused |
| Outages | Admin unavailable at cutoff, lost claim/report/Continue responses, Bee write failure | Closed ingress persists, exact pending operation reconciles, failed media remains recoverable, old replay remains available |
| Viewer | Join during grace, VOD, preparation and resumed live. Poll while old replay plays, then click Watch live | Existing playhead stays fixed until an explicit switch. Actual decoded markers identify the selected recording and all qualities |
| Compatibility | Incompatible opening media, missing old content, actual old-image candidates through installed test wrappers | Refusal before new media publication or service replacement. Existing replay and stored history remain intact |

Each stage links to the approved V01 through V22 matrix. Unit checks remain separate from media and browser results. The harness records the exact executed commands, candidate commits, artifacts, pass/fail/skip counts and any case not run. The funded OBS/real-Swarm case V20 remains a separate owner-coordinated acceptance stage.

## Current evidence boundary

Focused uploader, database and browser checks exist. The early real SRS probes ran. The full assembled private-chain media arrangement, cumulative decoding, process-crash media run and V20 have not run. Branch publication and the new late-rung host probe are currently waiting for renewed 1Password signing approval.
