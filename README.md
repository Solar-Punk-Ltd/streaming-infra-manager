# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer** — Bee light node, `stream-uploader` service, SRS.
- **Watcher** — N lightweight Docker containers running a Bee ultra-light node
  and the React streaming client, plus a small interface to start/stop them.

It also deploys the two halves of an ABR stage, which normally live on different
machines under different managers:

- **ABR Node Pool** — a deployment group with one Bee node per quality rung, as
  the publish targets. Produces the `BEE_PUBLISHERS` string.
- **ABR Uploader** — `srs` + `stream-uploader` publishing to that pool. No Bee
  node and no postage of its own; you paste the pool's `BEE_PUBLISHERS` in.

See [docs/features/abr-ladder.md](docs/features/abr-ladder.md).

## Layout

- `manager/swarm-hls-stream/` — git submodule pointing at
  [Solar-Punk-Ltd/swarm-hls-stream](https://github.com/Solar-Punk-Ltd/swarm-hls-stream)
  (`main`). This is the upstream application source: `packages/stream-uploader`,
  `packages/client`, `packages/cli`, and `engines/srs`. Docker images for the
  streamer and watcher servers are built from a pinned commit of this submodule.
  The manager lists it as the **bundled** stack version, and it is the default
  until another is chosen.
- `/home/solarpunk/streaming-infra-manager-versions/` on the deploy host, one
  directory per added stack version (`STACK_VERSIONS_ROOT`). Each holds a full
  checkout of another branch or tag with its packages built, about a gigabyte.
  It is a sibling of the data root and sits outside the tree `deploy/deploy.sh`
  rsyncs with `--delete`, so a manager deploy cannot wipe it. The Versions page
  in the manager adds, updates and removes these. See
  [docs/features/stack-versions.md](docs/features/stack-versions.md).
- `/home/solarpunk/streaming-infra-manager-data/<deployment>/` on the deploy
  host (`BEE_DATA_ROOT`): the deployment's Bee node data and keys, and under
  `engine/` the config file of its own when it runs on one. Survives a manager
  deploy, removed with the deployment. See
  [docs/features/engine-config.md](docs/features/engine-config.md).

## Checks

Every pull request into `main-v2` runs three jobs: the build and the unit
suites, the SQL suites against nine disposable databases, and the browser
suites against a real headless Chrome. A separate workflow, started by hand,
runs the container-backed regressions and the signed-in integration suite.
What each one proves, what it does not, and how to run any of it on a laptop:
[docs/ci.md](docs/ci.md).

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
