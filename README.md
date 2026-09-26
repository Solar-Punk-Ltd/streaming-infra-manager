# streaming-infra-manager

Deployment and orchestration tooling for testing the Swarm HLS live-streaming
stack. Targets two dedicated servers:

- **Streamer**: Bee light node, `stream-uploader` service, SRS.
- **Watcher**: N lightweight Docker containers running a Bee node, ultra-light
  unless it is created light, and the React streaming client, plus a small
  interface to start and stop them.

It also deploys the two halves of an ABR stage, which normally run on this one
host under this manager:

- **ABR Node Pool**: a deployment group with one Bee node per quality rung, as
  the publish targets. Produces the `BEE_PUBLISHERS` string.
- **ABR Uploader**: `srs` and `stream-uploader` publishing to that pool. It has
  no Bee node and no postage of its own. The wizard copies the pool's
  `BEE_PUBLISHERS` string into it.

An uploader on another machine is possible, and it needs two things: a
`BEE_LOCAL_HOST` naming an address that machine can reach, and a Bee API bind
that admits it. See [deploy/README.md](deploy/README.md) for the bind.

See [docs/features/abr-ladder.md](docs/features/abr-ladder.md).

## Layout

- `manager/swarm-hls-stream/`: a git submodule pointing at
  [Solar-Punk-Ltd/swarm-hls-stream](https://github.com/Solar-Punk-Ltd/swarm-hls-stream),
  pinned to the stack's release `v3.4`, commit
  `dc0c55e10651367d939b2b0c2c4ff6302fc65899`, as of 2026-09-25, with `main` as
  its tracked branch. This is the upstream application source, with the
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

The `checks` workflow declares four jobs on every pull request and push to
`main` (and `main-v2` during the release transition): the build and the unit suites, the SQL suites against nine
disposable databases, the browser suites against a real headless Chrome, and a
build of the web and api images the way a deploy builds them on the host. A
second workflow, started by hand, runs the container-backed regressions and the
signed-in integration suite. Its five runs on push events of 2026-09-10 and
2026-09-11 all failed. Dispatched by hand, it first passed on 2026-09-19 (run
35447516491) and has passed on every stack pin move since, most recently run
36099132624 on 2026-09-25 for `v3.4`, read on GitHub that day. What each job proves, what it does not, and how to
run any of it on a laptop: [docs/ci.md](docs/ci.md).

## Documents

- [docs/features/](docs/features/): one page per feature, what the operator
  sees and how the code behaves. Start here to understand a capability.
  - [stack-versions.md](docs/features/stack-versions.md): versions, immutable
    builds, the copies a deploy runs from, and settings revisions.
  - [engine-control.md](docs/features/engine-control.md): engine settings,
    restart, logs and the effective config from the UI.
  - [engine-config.md](docs/features/engine-config.md): a deployment's own SRS
    or OvenMediaEngine configuration file.
  - [deployment-settings.md](docs/features/deployment-settings.md): every key a
    deployment's version declares and its engine settings, set for one
    deployment on its page or in the new-deployment wizard, and Apply for the
    containers behind on them.
  - [srt-ingest-health.md](docs/features/srt-ingest-health.md): how the SRT
    link from the broadcaster held up over the last minute, from SRS's own
    statistics, and what to change when it drops packets.
  - [group-deployment.md](docs/features/group-deployment.md): several
    deployments created at once under one name.
  - [abr-ladder.md](docs/features/abr-ladder.md): a node pool with one Bee node
    per quality rung, and the pool string an uploader publishes to.
  - [chequebook.md](docs/features/chequebook.md): funding a node's chequebook
    and recovering a transfer.
  - [postage-stamps.md](docs/features/postage-stamps.md): what a postage batch
    is, and buying, using, topping up and diluting one on a deployment's
    Storage card.
  - [auth-and-public-access.md](docs/features/auth-and-public-access.md): the
    login gate, the HTTPS edge, the API binds and the host firewall.
  - [next-features-2026-09.md](docs/features/next-features-2026-09.md): the
    September plan, kept as the record of what was asked for and why.
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

The bundled stack is pinned to the stack's release `v3.4`, commit `dc0c55e1`,
as of 2026-09-25. It builds on `v3.1`, pinned from 2026-09-19, which
brought PR #241 and the manager integration work previously carried by
`feat/manager-line`. Over `v3.1` it makes SRT ingest wait 2000 ms for a lost
packet by default, where `v3.1` asked for 200 ms and SRS waited its own
120 ms, because the template filled `latency` and not `recvlatency`. An SRS
encoder that drops and returns inside the reap window, 60 s by default, now
resumes its broadcast instead of starting a new one, while OME still ends it.
Both came with `v3.2`. `v3.3` adds three fixes for what a tester hit on
2026-09-23. A ladder with a rung that cannot finish, such as one whose postage
batch filled, is listed as a recording of the rungs that did finish, instead of
staying live for good and hiding every broadcast after it. A rung whose uploads
are refused stays out of the master playlist until it uploads cleanly again.
And the viewer's stream cards show their picture behind its `/bee` proxy.
`v3.4` adds the fixes from that tester's stage and from a live test of it on
2026-09-24 and 2026-09-25. The uploader starts on a full mutable postage
batch, whose node overwrites its oldest chunks rather than refusing an upload,
and holds only an immutable batch to its start ceiling. A long recording's card
shows its picture. The viewer's page tells browsers to check for a new copy on
every load, so a redeploy reaches every browser. A viewer who saw a broadcast end follows it when it comes back,
and a watch page opened before a scheduled stream starts picks it up when it
does. An ordinary end of a broadcast no longer logs that the engine may have
died. And the ingest refuses a publish nobody authenticated unless the stack's
own transcoder sent it from the same host.
The upstream default branch is `main`.

Pin an explicit release or commit when upgrading the bundled stack, a release
when one carries the change you need and a commit when none does yet. `<ref>`
below is either one, a tag such as `v3.4` or a full commit id such as
`8c5c583a9fdd4604a602433112410f5a996952ee`:

```sh
git -C manager/swarm-hls-stream fetch origin --tags
git -C manager/swarm-hls-stream checkout --detach <ref>
git add manager/swarm-hls-stream
git commit -m "chore: pin swarm-hls-stream <ref>"
```

The fetch brings every branch and every tag of the stack, so a release tag and
a commit on any branch both resolve.

To test the latest upstream `main` instead, use the tracked branch:

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
