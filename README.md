# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer**: Bee light node, `stream-uploader` service, SRS.
- **Watcher**: N lightweight Docker containers running a Bee ultra-light node
  and the React streaming client, plus a small interface to start and stop them.

It also deploys the two halves of an ABR stage, which normally live on different
machines under different managers:

- **ABR Node Pool**: a deployment group with one Bee node per quality rung, as
  the publish targets. Produces the `BEE_PUBLISHERS` string.
- **ABR Uploader**: `srs` and `stream-uploader` publishing to that pool. It has
  no Bee node and no postage of its own. You paste the pool's `BEE_PUBLISHERS`
  in.

See [docs/features/abr-ladder.md](docs/features/abr-ladder.md).

## Layout

- `manager/swarm-hls-stream/`: a git submodule pointing at
  [Solar-Punk-Ltd/swarm-hls-stream](https://github.com/Solar-Punk-Ltd/swarm-hls-stream),
  tracking `main-v3`. This is the upstream application source, with the
  packages under `packages/` and the engine trees under `engines/`. The commit
  it records is the **bundled** stack version, and that version is the default
  until another is chosen. A deploy does not carry this tree. It writes the
  recorded commit into `manager/.stack-commit`, and the server fetches and
  builds that commit itself, the same way it builds any version added on the
  Versions page.
- `/home/solarpunk/streaming-infra-manager-versions/` on the deploy host
  (`STACK_VERSIONS_ROOT`). Each version keeps three siblings there:
  `<name>.repo/`, the clone it builds from, `<name>.builds/<build id>/`, one
  immutable directory per published build, and `<name>/`, the settings files
  the operator owns. A build is a checkout with its packages built, so it runs
  to about a gigabyte, and more than one build of a version can be kept at
  once. The root is a sibling of the data root and sits outside the tree
  `deploy/deploy.sh` rsyncs with `--delete`, so a manager deploy cannot wipe
  it. The Versions page adds, updates, configures and removes these. See
  [docs/features/stack-versions.md](docs/features/stack-versions.md) and
  [deploy/README.md](deploy/README.md).
- `/home/solarpunk/streaming-infra-manager-data/<deployment>/` on the deploy
  host (`BEE_DATA_ROOT`): the deployment's Bee node data and keys, and under
  `engine/` the config file of its own when it runs on one. Survives a manager
  deploy, removed with the deployment. See
  [docs/features/engine-config.md](docs/features/engine-config.md).
- `/home/solarpunk/manager-ssh/` on the deploy host (`MANAGER_SSH_DIR`): the ssh
  identity the manager deploys to *other* hosts with (the deploy key, an
  `ssh_config` with a `Host` block per target alias, and `known_hosts`),
  bind-mounted into the api container at `/root/.ssh`. Another sibling outside
  the tree `deploy/deploy.sh` rsyncs, and only needed when a deployment's host
  is not `localhost`. See [deploy/README.md](deploy/README.md).

## Checks

The `checks` workflow declares three jobs on every pull request and push to
`main-v2`: the build and the unit suites, the SQL suites against nine
disposable databases, and the browser suites against a real headless Chrome. A
second workflow, started by hand, runs the container-backed regressions and the
signed-in integration suite. Checked on GitHub on 2026-09-16: nobody has ever
dispatched that second workflow by hand. It has run five times on its own, on
push events between 2026-09-10 and 2026-09-11, and every one of those five runs
failed. There has been none since, so no successful run of the container-backed
regressions is recorded here. What each job proves, what it does not, and how to
run any of it on a laptop: [docs/ci.md](docs/ci.md).

## Documents

- [docs/features/](docs/features/): one page per feature, what the operator
  sees and how the code behaves. Start here to understand a capability.
- [docs/ci.md](docs/ci.md): what each CI job proves, what it does not, and how
  to run any suite on a laptop.
- [docs/testing/](docs/testing/): what particular suites cover and, as
  importantly, what they do not model.
- [docs/handover/](docs/handover/): the narrative of the main-v2 remediation,
  one dated section per slice, including what the first real deploy found.
- [docs/consensus/](docs/consensus/): the record of the cross-provider review
  that produced that remediation. The PRD, the 25 rows, the briefs and the
  acceptance trail. These are records of finished work and not instructions,
  and each one says so on its first lines. Its README is the index.
- [docs/ux/](docs/ux/): the UX rework brief and the clickable mockup it was
  decided from. Merged 2026-09-05.

## Cloning this repository

This repo uses a **git submodule** (the `manager/swarm-hls-stream/` directory). A plain
`git clone` will leave that directory empty, which will break every later step.
Use one of the two flows below.

### Option A, clone everything in one go (recommended)

```sh
git clone --recurse-submodules https://github.com/Solar-Punk-Ltd/streaming-infra-manager.git
cd streaming-infra-manager
```

The `--recurse-submodules` flag tells git to also fetch the contents of every
submodule. After this completes, `manager/swarm-hls-stream/` will be populated.

### Option B, you already cloned without the flag

If you ran a plain `git clone` and `manager/swarm-hls-stream/` is empty, run this once
inside the repo:

```sh
cd streaming-infra-manager
git submodule update --init --recursive
```

`--init` registers the submodule locally, which is needed the first time only.
`--recursive` also pulls any submodules of submodules. Re-running this is safe
at any time and does not overwrite committed work.

### How to tell it worked

```sh
ls manager/swarm-hls-stream/packages
```

That should print several package directories, `cli`, `client` and
`stream-uploader` among them. If the directory is empty, the submodule was not
fetched. Go back to Option A or B.

## Updating the upstream submodule

To pull the latest commits from the branch the submodule tracks, `main-v3`:

```sh
git submodule update --remote manager/swarm-hls-stream
git add manager/swarm-hls-stream
git commit -m "chore: bump swarm-hls-stream"
```

Give the path, `manager/swarm-hls-stream`, and not the submodule's name. The
first command moves the submodule to the tip of the tracked branch. The next
two record that move as a commit here, so every clone pins the same version,
and so does the next deploy, which writes that commit into
`manager/.stack-commit` for the server to build.
