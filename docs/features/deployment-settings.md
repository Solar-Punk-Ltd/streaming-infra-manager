# A deployment's own settings

Status: the store, the record of what each container got, the API, and the page that edits them, as
of 2026-09-26 on `feat/deployment-settings-page`. The new-deployment wizard does not carry the editor
yet.

## What this is

Every key a deployment's stack version declares is editable per deployment, with the version's value
as the default. Levi ruled this on 2026-09-25 ("fully configurable all envs and params everywhere,
just give defaults where it make sense"). A deployment's own value goes into its env file,
`.env.<name>`, over the version's base `.env`, and the manager's own lines are written after it. So a
stored value never takes the place of a key the manager computes.

## Where a value comes from

Each key of the list says where the value its next deploy writes comes from:

| Source | Meaning |
| --- | --- |
| deployment | stored for this deployment |
| version | set by the version's build, in its base or its engine env file |
| manager | decided by one of the deployment's own controls, named on the key |
| generated | a secret the manager generated for this deployment |
| unset | set by nothing, so the stack's own default applies |

The controls that decide a key are the services the deployment runs, its postage stamp, its node pool,
its chain endpoint and the gateway's node mode, its Bee URL, its SRT passphrase, its feed key, owner
and topic, the engine's own config file, the engine settings, the port slot, and on the manager's own
host the data directories. A save that names one of those keys is refused with the control named.
A value stored for one before a manager started deciding it is left out of the env file and named in
the log.

A generated secret is the exception. A value stored for it replaces the generated one, and the
generated one stays kept for when the value is reset.

## What is never shown

A secret, anything the settings page masks, is never answered, only whether one is stored. A chain
endpoint is answered by its host alone, because its path or user info can carry a provider's key.
The log names the keys a save changed and never a value.

## Behind, and Apply

Every successful deploy records, per container it started, a salted digest of every key that
container's compose block reads. It also records the keys the version declares that only the deploy
scripts read, an unset key included. The list compares those records with what the next deploy would
write, so it can say which settings the running containers are behind on:

- **same:** the running container got this value.
- **differs:** it got another one.
- **unknown:** no record can tell, which is the case until a deployment's first deploy after this
  feature.
- **not-running:** the deployment is stopped.

Apply redeploys only the containers that are behind. When a changed key reaches the deploy scripts
alone, it redeploys everything. A stopped deployment's Start uses the stored values anyway, so Apply
refuses it.

A save stores and changes nothing that runs. It names the revision the page read, and a save made
against an older one is refused. So two operators editing at once cannot overwrite each other unseen.

## The shape a value may have

Every value answers to the rules of the version settings page, which keep out a value the stack's
loader and the manager's parser would read differently. For the keys whose accepted values are
certain, such as the start gate mode, the chequebook floor and re-check interval, the stamp limits,
the log level and format, and the switches, the value is also held to the stream uploader's own
bounds, in `common/src/stackSettingFields.ts`. Any other key is plain text, checked by its container
when it starts.

## API

`GET /profiles/:name/settings`, `PUT /profiles/:name/settings` and `POST
/profiles/:name/settings/apply`, described in `manager/README.md` under "A deployment's own
settings".

## The page

A deployment's page shows these settings in a **Stack settings** card after the Engine card, the
whole width of the main column. The Engine card and its settings drawer are unchanged, and the engine
settings show in this list as keys the engine settings decide.

- **Folded by the sample's sections**, in the order they first appear, with the keys the version no
  longer declares in a section of their own at the end. A section opens on a click, and a search by
  key or description opens every section it matches and keeps only the matching keys. A folded
  section's line counts its keys and says how many are unsaved, cannot be saved or are not applied.
- **Each key** shows its description, folded to its first words when long, and a field shaped by what
  it takes: a list for a choice, a switch for true or false, a number field with its bounds, and text
  otherwise. The version's value is beside it as the default, with a reset to it when the deployment
  stores a value. A changed key, and a saved one the containers do not have yet, is marked with the
  services applying it recreates, or with full redeploy.
- **A secret** is a masked field that starts empty and is never filled from the manager. The page
  says whether one is stored, generated or set by the version, and it can be replaced or reset.
- **A key a control of the deployment decides** shows its value and names the control, with no field.
  A value stored for it before a control decided it can be reset.
- **A key the version no longer declares** shows its stored value and offers only a reset.

A value the manager would refuse is named under its field, by the same shared rules, and keeps Save
off. Save sends the changed keys in one request with the revision the page read. A refused save shows
the manager's sentence under the button. A save refused because another one landed first says the
settings changed elsewhere and reads them again, and the change has to be made again.

Above the list, the banner names the settings the running containers are behind on and offers Apply,
and after Apply says what was recreated. On a stopped deployment it says what Start will use, with no
Apply. Where no container has a record to compare with, which is every deployment deployed before
this feature, the card says so, because no key of it can show as behind until its next deploy.

The editor is its own component, `frontend/src/deployments/settings/DeploymentSettingsEditor.tsx`,
and the card only frames it. It fits 390 pixels with no sideways scroll. `frontend/test/deployment-settings-browser.test.mjs`
drives it in Chrome, and the mock manager answers the three routes, so `pnpm -C frontend dev:mock`
shows it with no manager: main-stage is behind on a saved key, old-demo is stopped with one waiting
for its Start, and field-unit has no records to compare with.

## Limits

- The stack's sample has no section rule closing "Per-rung Bee nodes", so the start gate settings
  that follow it are listed under that section until the sample gains one.
- A deployment deployed before this feature has records that cannot tell, so its keys read unknown
  until its next deploy. Apply has nothing to recreate for such a deployment, so a saved value
  reaches it at that next deploy, such as a Stop and a Start.
- The page cannot store an empty secret, because an empty secret field means keep what is stored.
  A reset puts back what the version sets.
- A stored secret's default says what the version sets. The list does not say whether the manager
  had generated one before, which is the value a reset of such a key goes back to.
