# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer** — Bee light node, `stream-uploader` service, SRS.
- **Watcher** — N lightweight Docker containers running a Bee ultra-light node
  and the React streaming client, plus a small interface to start/stop them.

It also deploys **ABR ladders**: a deployment group with one Bee node per quality
rung, as the publish targets for a `stream-uploader` running elsewhere. See
[docs/features/abr-ladder.md](docs/features/abr-ladder.md).

## Layout

- `manager/swarm-hls-stream/` — git submodule pointing at
  [Solar-Punk-Ltd/swarm-hls-stream](https://github.com/Solar-Punk-Ltd/swarm-hls-stream)
  (`main`). This is the upstream application source: `packages/stream-uploader`,
  `packages/client`, `packages/cli`, and `engines/srs`. Docker images for the
  streamer and watcher servers are built from a pinned commit of this submodule.

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

When you want to pull the latest commits from `swarm-hls-stream`'s `main`
branch into this repo:

```sh
git submodule update --remote swarm-hls-stream
git add swarm-hls-stream
git commit -m "chore: bump swarm-hls-stream"
```

The first command moves the submodule to the latest upstream commit; the next
two record that move as a commit in this repo, so other clones get the same
pinned version.
