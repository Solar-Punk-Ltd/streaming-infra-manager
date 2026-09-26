# A deployment's own settings

Status: the store, the record of what each container got, the API, the page that edits them, and the
new-deployment wizard that creates a deployment with them already set, as of 2026-09-26 on
`feat/deployment-settings-wizard`.

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
/profiles/:name/settings/apply`, and for a deployment not created yet `GET
/versions/:id/settings-catalog` and the `stack_settings` of `POST /profiles` and `POST /groups`, all
described in `manager/README.md` under "A deployment's own settings".

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

## In the new-deployment wizard

Plan item C.5: a deployment is created with its settings already set. The wizard's settings step
ends with an **Advanced settings** fold, folded until opened, because most deployments keep every
version value. Its line says what it holds, and once values are typed, how many the create sends or
which value it cannot send.

Opened, it shows the same list, rows and fields as the deployment's page, read from `GET
/versions/:id/settings-catalog` for the version, the services and the host the create body will
name. A node pool is asked for as one of its rungs, a Bee node alone. The list is read from the
settings step on, and again whenever the version, the engine, the services or the host change.

- **Nothing is stored yet**, so there is no banner, no Apply, no revision and no Save. A changed key is
  marked changed rather than unsaved, and marks nothing to recreate. Undo takes a value back out,
  which is the whole of going back to the version's value.
- **A required secret** the version leaves empty says the manager generates it at the first deploy,
  and a typed one replaces that.
- **A key a control decides** shows no field and names the control. `HLS_FRAGMENT`, which the engine
  settings decide, shows the segment length typed above it, so the two never read differently.
- **A value the manager would refuse** is named under its field, by the same shared rules, and stops
  Continue and Deploy, the footer naming the key and never the value. Values typed before the list
  for the current choices was read wait for it.
- **A key typed under an earlier choice** that the list for the current one does not take, such as
  an SRS key after switching to OvenMediaEngine, is kept rather than dropped, said to be not sent, and
  comes back if the earlier choice does. A new goal starts the typed values over.

Deploy sends the typed keys the current list takes as `stack_settings`. The manager checks them
against the same list with the rules a save uses, `settingEditProblems`, and refuses the whole create
over one bad key, naming it. Accepted values are stored at the insert, plain and secret apart, so the
first deploy writes them and the deployment's page lists them as its own at revision 0. A group gives
every member the same values, a node pool's four rungs included, and a member appended to a group
later takes those of the group's first member, as it takes that member's engine settings. The review
names the keys the create sets and never a value.

The editor is `frontend/src/deployments/settings/NewDeploymentSettingsEditor.tsx`, built from the
same `SettingsList` as the page's editor, and the fold is
`frontend/src/forms/wizard/steps/AdvancedSettings.tsx`. `frontend/test/wizard-settings-browser.test.mjs`
drives it in Chrome at 390 pixels through the mock manager, which answers the list and stores what a
create sends, so `pnpm -C frontend dev:mock` shows it with no manager.

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
- The wizard's typed values live only while the dialog is open. Closing it forgets them, as it
  forgets every other choice made in it.
- A member appended to a group takes the settings of the group's first member, so a value changed on
  that member alone after the group was created travels to the new one, as its engine settings do.
- The wizard checks a typed value against the list it read, and the manager checks it again against
  the version's current build when the create arrives. A build published in between can refuse a
  create the wizard let through, and the refusal names the key.
