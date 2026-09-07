# Engine configuration

Full control of the media engine's configuration file, per deployment, from the
manager, with the file checked before the engine is recreated on it and rolled
back when the engine will not start.

## Motivation

The engine settings drawer edits the handful of values the stack's config
template leaves open: on a plain stream deployment that is the segment length
and the playlist window, with the ABR ladder a few more. Everything else SRS or
OvenMediaEngine can do is fixed in the template. Levi wants every option
reachable, on 2026-09-07: "I want full customization, supporting all options".

Neither engine has a configuration website to open instead:

- **SRS** is configured by `srs.conf` alone. Its HTTP API (port 1985) reports
  stats and can kick clients, and the separate SRS console is a monitor. Neither
  writes configuration. The reference is the annotated
  [`full.conf`](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf).
- **OvenMediaEngine** is configured by `Server.xml`. Its REST API manages
  virtual hosts, applications and streams at runtime, is off in the stack, and
  does not replace the file. The reference is the
  [configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration).

So the feature is a config file editor in the manager, and a hook in the stack
that runs the engine on that file instead of the template.

## How the stack renders the config today

`engines/srs/entrypoint.sh` copies `srs.conf.template` and substitutes tokens:
`PASSPHRASE_PLACEHOLDER`, `SRS_ADAPTER_HOST_PLACEHOLDER`,
`SRS_ADAPTER_PORT_PLACEHOLDER`, `HLS_FRAGMENT_PLACEHOLDER`,
`HLS_WINDOW_PLACEHOLDER`, `INGEST_HLS_PLACEHOLDER`, and the ladder fragments
`TRANSCODE_PLACEHOLDER` and `ABR_VHOST_PLACEHOLDER`. `engines/ome/entrypoint.sh`
does the same for `Server.xml.template` with `OME_ADAPTER_HOST_PLACEHOLDER`,
`OME_ADAPTER_PORT_PLACEHOLDER`, `OME_ADMISSION_SECRET_PLACEHOLDER`,
`SEGMENT_DURATION_PLACEHOLDER` and `SEGMENT_COUNT_PLACEHOLDER`. The values come
from `.env.<profile>`, which the manager writes on every deploy.

## The shape

**A deployment may carry its own config file.** `profiles.engine_config` holds
the whole file as text, or null for "render the template as today". The editor
opens on the template of the deployment's stack version with the placeholders
still in it, the operator edits, and saves.

**Placeholders survive in a custom file.** The entrypoint runs the same
substitutions on the custom file as on the template. So the passphrase, the
adapter address, the ladder fragments and the two managed values never sit in
the stored text, and the engine settings drawer keeps working: it edits the
values, the file edits the structure. A field whose token the operator removed
from the file is shown as "not in your config" in the drawer rather than
silently ignored.

**Nothing is applied unchecked.** Save runs the check below, and only a file
that passes is stored and rolled out.

**The engine is recreated on it, the way engine settings already do it.** Claim
the deployment, write the file to the deployment's own directory on the host,
point the engine at it through `.env.<profile>`, recreate the engine container
only. Then watch it for twenty seconds. An engine that exits in that window gets
the previous file back, is recreated again, and the deployment is marked with
the error and the last lines of the engine's log, so a bad file costs one
failed start and nothing else.

**Only on a stack version that supports it.** The version's contract advertises
`engineConfig` for each engine. The bundled `main-v2` does not, so the editor
says "This stack version renders its config from a template. Deploy on
`main-v3` to edit it." That makes the wizard's version select a prerequisite,
the one the stack versions brief already names as its next pull request.

## The check

- **SRS**: `srs -t -c <file>` in a throwaway container of the deployment's SRS
  image, on a copy of the file with every placeholder substituted by a dummy
  value, so the parser sees a complete file. SRS refuses unknown directives and
  bad values with a line number, which is shown as is.
- **OME**: well-formed XML and the presence of the elements the stack relies on
  (the admission webhook and the LLHLS publisher). OME has no offline check, so
  the twenty second watch after recreate is the real gate for it.

## Where things go

| Piece | Repo and branch | Notes |
|---|---|---|
| Wizard version select | manager `main-v2` | The stack versions brief's next PR. New deployments pick their version, the default stays preselected. |
| Config override hook and contract flag | swarm-hls-stream `main-v3` | `SRS_CONF_SOURCE` and `OME_CONF_SOURCE` in the entrypoints, a `/config` mount in the compose files, `engineConfig` in the contract JSON. |
| Editor, check, rollout, rollback | manager `main-v2` | Migration 012 adds `engine_config`. Routes `GET`, `PUT`, `DELETE /profiles/:name/engine-config`. The drawer gets an "Engine config" tab beside the settings. |
| Docs | manager `main-v2` | The drawer links the two references above and a short page in `docs/` on what survives a manager deploy and what does not. |

The file itself lives in the deployment's data directory on the host, next to
the Bee node's data: it survives manager deploys, which rsync only the checkout,
and goes with the deployment when that is removed.

## Order

1. Wizard version select. Small, unblocks running anything on `main-v3` from the UI.
2. Stack hook on `main-v3`, with the contract flag. The manager reads the flag on the next Update of the version.
3. Manager editor with check, rollout and rollback, behind the flag.
4. Docs and the drawer's "not in your config" notes.

## Open decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | The editor's unit. | (a) The whole file, placeholders kept, as above. (b) More template fields in the drawer, no file. (c) Both. | (a), which is (c) in effect because the drawer keeps working through the placeholders. (b) never reaches "all options". |
| D2 | The editor component. | (a) A plain monospace text area with line numbers, no new dependency. (b) CodeMirror 6 with syntax colouring, a new dependency with the provenance checks that brings. | (a) first. Colouring can come later if the file editing is used enough to want it. |
| D3 | What happens when the engine will not start on the new file. | (a) Restore the previous file, recreate, mark the deployment with the engine's log tail. (b) Leave it down and mark the error. | (a). A stream deployment that stays down because of a typo is the worst outcome of the feature. |
| D4 | OME in the same round. | (a) Yes, the same hook and editor, XML well-formedness as its check. (b) SRS only. | (a). The mechanism is the same and no OME deployment exists to break. |
| D5 | Who may edit engine config. | (a) Anyone signed in, like every other deployment edit. (b) Users who can manage users only. | (a). It changes one deployment, not who can get in. |
| D6 | Should the wizard's version select also let a running deployment be moved to another version? | (a) Not in this round: new deployments only, as the stack versions brief planned. (b) Add "Deploy on version X" to a running deployment. | (a). Moving a deployment changes its ports and secrets contract and deserves its own brief. |
