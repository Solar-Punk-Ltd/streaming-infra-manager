# The first real deploy and the signed-in live test, 2026-09-10

A runbook for one session with Levi present. It deploys `feat/ai-remediation` to the live test host for the first time since the remediation began, then proves the manager end to end while signed in, without spending. The paid part is a later step.

## What the host holds today

Host 157.90.34.105 (Hetzner, user `solarpunk`, key `ll_1`, `IdentitiesOnly`). The manager there is main-v2 at d046ebf, deploy round 10 of 2026-09-08, public at https://streamtestinfra.swarmens.limo behind the Caddy edge, with the nft firewall applied and the tunnel `host-157-tunnel` (localhost:8090) as the way back in. Migrations 001 to 012 are applied. Four deployments: `livetest-stream` (slot 1, bundled main-v2, its stamp expired on 2026-09-08), `livetest-viewer` (slot 2), `v3-config-test` (slot 3, main-v3, unfunded) and `review-20260907` (slot 4, main-v3, funded, never disposable, its 0.5 BZZ chequebook fill has an unverified submission). Two versions: `bundled` (main-v2 ee99c36, the flat tree at `~/streaming-infra-manager/manager/swarm-hls-stream` with the host's own `.env`) and `main-v3` (a flat checkout Levi has Updated). Users: `claude` (admin) and any Levi added. The postgres password rotation is still open.

## What the deploy does to it

`bash deploy/deploy.sh 157.90.34.105` from the laptop, on the merged branch:

1. rsyncs the manager only. The stack tree is excluded. The local `manager/.env` ships with it and holds `MANAGER_DOMAIN` and the postgres password, so the public edge stays.
2. builds the images on the host and runs `manager:upgrade` in a one-off container: checking (the guard directory, and whether this is an installed manager with its data volume), stopping the old api, migrating 013 to 030 (18 migrations, once, one way, no rollback by D08), starting, verifying `/health`, then waiting up to twenty minutes for the api's own boot to build the pinned stack commit 9f1255b (main-v3) on the host.
3. the bundled version's first build here carries the host's stack `.env`, `deploy/config.json` and engine envs into `~/streaming-infra-manager-versions/bundled/` as revision 1, owner only, completes the keys main-v3 adds from the sample (blank where the sample is blank), seeds an env for every engine the tree ships, clones into `bundled.repo`, builds in `node:22-alpine`, publishes build 9f1255b and prunes. The bundled row moves from the flat layout to builds. The old main-v2 tree stays for the engines that mount it.
4. restarts only the manager's own containers. The four deployments keep running as they are. From then on a Deploy of `livetest-stream` or `livetest-viewer` runs them on main-v3, which is what D09 decided.

If the upgrade stops half way the guard directory stays and the next deploy refuses, see `deploy/README.md`, "A deploy that stopped half way". The database is safe to leave as it is. A bundled build that fails leaves a failed reason on the Versions page and Update runs it again.

## What Levi does

1. Names a time. About one hour for the deploy and the checks, more for the walkthrough.
2. Approves the 1Password prompt for `ll_1` on the first ssh, and again if the vault re-locks.
3. Signs in himself in the browser. Nobody types a password for him.
4. Decides whether the host is a test target for the integration suite. The suite creates and removes only its own `itest-*` deployments, refuses everything else, and the nodes it makes are unfunded, one slot each. If yes: a user `itest` created on the host with `--password-stdin` from 1Password, and `manager/test/integration/env.itest` on the laptop holding `op://` references only, with `MANAGER_URL` and `MANAGER_TEST_TARGET` both `http://localhost:8090`.
5. Funds nothing. The paid part waits for the D05 numbers.

## The signed-in end-to-end pass, unpaid

a. `/health` answers 200 over the tunnel, `docker compose logs api` on the host shows migrations 013 to 030 applied and the bundled build's log, the Versions page shows `bundled` Ready on 9f1255b with its build id.
b. Settings on `bundled`: the carried-over values are there (the two BIND lines), the keys main-v3 added are blank, the engine section exists. One save, then Save and apply, gives build 9f1255b-r1 and the page says `applied`. Settings on `main-v3` says Update first, because it is still a flat checkout. Update it, and its settings appear.
c. The integration suite from the laptop over the tunnel, `op run --env-file test/integration/env.itest -- pnpm test:integration` from `manager/`: the signed-in checks, the viewer, streamer and custom lifecycles (deploy, modify, stop, remove), the group edit, the group resize, the ABR pool. Minutes per deploy.
d. Levi's own walkthrough, with the browser pane open: the wizard with the version select, a deployment page, readiness, the engine settings drawer, the config file dialog, the chequebook card read only, the Versions actions, Access, sign out everywhere.
e. Snapshots of `/health` and `/metrics` before and after, filed with the report in the handover.

## Things to know before saying go

- The migrations are one way. There is no rollback catalogue, by D08. Proceeding is the decision.
- The host runs the manager's api as root, so the files under the versions root are root's and the ssh editing script needs `sudo` there. The page needs nothing.
- The per-deployment env file of each existing deployment becomes owner only on its next deploy, not before.
- `review-20260907` is not touched by anything in this pass. The integration suite never names it and refuses to remove anything it did not create.

## The paid part, later (T22)

The fault scenarios on `feature/e2e-suite` (bee outage short and long, engine restart, uploader crash, stop to VOD, gateway outage, happy path, catalog via the gateway, two concurrent streams) publish real streams and burn stamp, attach over ssh, and that branch is 972 commits behind with an old stack pin, so porting `e2e/` onto the current branch is a slice of its own. The alternative that proved the whole pipeline on 2026-09-07 is a ninety second ffmpeg SRT test stream on a funded deployment. Either needs the D05 numbers: the cap, the duration, the input and what happens to the funds afterwards.
