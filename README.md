# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer** — Bee light node, `stream-uploader` service, SRS.
- **Watcher** — N lightweight Docker containers running a Bee ultra-light node
  and the React streaming client, plus a small interface to start/stop them.

## Layout

- `manager/swarm-hls-stream/` — git submodule pointing at
  [Solar-Punk-Ltd/swarm-hls-stream](https://github.com/Solar-Punk-Ltd/swarm-hls-stream)
  (`main`). This is the upstream application source: `packages/stream-uploader`,
  `packages/client`, `packages/cli`, and `engines/srs`. Docker images for the
  streamer and watcher servers are built from a pinned commit of this submodule.

## Profiles

Everything the manager deploys is organized into **profiles** — named, self-contained
deployments of the whole stack (media engine, `stream-uploader`, bee uploader/gateway
nodes, client). You create one in the manager UI/API with:

- a **name** of your choice — it becomes the docker-compose project, so containers are
  named `<profile>-<service>-1`;
- a **port slot** — every host port is `base + slot*10` (e.g. slot 2 → uploader API
  10020, SRT 10021, client 10024);
- an **engine** (`srs` or `ome`) and a **postage stamp** for Swarm uploads.

On each deploy the manager generates the profile's config itself: it writes
`.env.<profile>` next to the submodule (a copy of the base `.env` with `ENGINE`,
`STAMP`, and slot-derived ports upserted — see `manager/src/utils/envUtils.ts`) and
creates per-profile bee data dirs. Nothing is tied to any particular profile name:
anyone can clone this repo, deploy the manager, and create their own profiles. The
e2e suite ([`e2e/README.md`](e2e/README.md)) attaches to any profile via
`E2E_PROFILE` / `E2E_PORT_SLOT` / `E2E_ENGINE`.

## Cloning this repository

This repo uses a **git submodule** (the `manager/swarm-hls-stream/` directory). A plain
`git clone` will leave that directory empty, which will break every later step.
Use one of the two flows below.

### Option A — clone everything in one go (recommended)

```sh
git clone --recurse-submodules https://github.com/Solar-Punk-Ltd/streaming-infra-manager.git
cd streaming-infra-manager
```

The `--recurse-submodules` flag tells git to also fetch the contents of every
submodule. After this completes, `manager/swarm-hls-stream/` will be populated.

### Option B — you already cloned without the flag

If you ran a plain `git clone` and `manager/swarm-hls-stream/` is empty, run this once
inside the repo:

```sh
cd streaming-infra-manager
git submodule update --init --recursive
```

`--init` registers the submodule locally (first time only); `--recursive` also
pulls any submodules-of-submodules. You can re-run this any time it's safe — it
won't overwrite committed work.

### How to tell it worked

```sh
ls manager/swarm-hls-stream/packages
# should print:  cli  client  stream-uploader
```

If that directory is empty, the submodule wasn't fetched — go back to Option A
or B.

## Updating the upstream submodule

`git submodule update --remote` follows whichever upstream branch `.gitmodules`
names for the submodule, **not** always `main`. Check it before bumping:

```sh
git config -f .gitmodules submodule.swarm-hls-stream.branch
```

On a branch that is testing unreleased uploader work this points at that
feature branch, so a bump keeps tracking the code under test. On trunk it
points at `main`. To pull the latest commits from whichever branch that is:

```sh
git submodule update --remote manager/swarm-hls-stream
git add manager/swarm-hls-stream
git commit -m "chore: bump swarm-hls-stream"
```

The first command moves the submodule to the latest upstream commit; the next
two record that move as a commit in this repo, so other clones get the same
pinned version. Note the argument is the submodule's **path**
(`manager/swarm-hls-stream`), not its name.
