# A deployment's own settings

Status: the store, the record of what each container got, the API, the page that edits them, the
new-deployment wizard that creates a deployment with them already set, and the engine settings in
the same list in place of the Engine card's drawer, as of 2026-09-26 on
`feat/deployment-settings-engine`.

## What this is

Every key a deployment's stack version declares is editable per deployment, with the version's value
as the default. Levi ruled this on 2026-09-25 ("fully configurable all envs and params everywhere,
just give defaults where it make sense"). A deployment's own value goes into its env file,
`.env.<name>`, over the version's base `.env`, and the manager's own lines are written after it. So a
stored value never takes the place of a key the manager computes.

The deployment's engine settings are in the same list, so a deployment has one list of settings
(Levi, 2026-09-26). They are stored where they always were, in `profiles.engine_settings`, and held
to the engine's own rules, as [The engine settings](#the-engine-settings) below says.

## Where a value comes from

Each key of the list says where the value its next deploy writes comes from:

| Source | Meaning |
| --- | --- |
| deployment | stored for this deployment |
| version | set by the version's build, in its base or its engine env file, and for an engine setting what the version falls back to where the host sets nothing |
| manager-default | an engine setting's default that is the manager's own, the SRT latency's 2000 |
| manager | decided by one of the deployment's own controls, named on the key |
| generated | a secret the manager generated for this deployment |
| unset | set by nothing, so the stack's own default applies |

The controls that decide a key are the services the deployment runs, its postage stamp, its node pool,
its chain endpoint and the gateway's node mode, its Bee URL, its SRT passphrase, its feed key, owner
and topic, the engine's own config file, the port slot, and on the manager's own host the data
directories. A save that names one of those keys is refused with the control named. A value stored
for one before a manager started deciding it is left out of the env file and named in the log.

A generated secret is the exception. A value stored for it replaces the generated one, and the
generated one stays kept for when the value is reset.

## The engine settings

Every engine setting the deployment reads is listed as its own to set, whether the version's samples
declare it or not, in the order the engine's field list gives them: for SRS the segment length, the
force-close ceiling, the playlist window and the SRT latency, and on an ABR uploader the seven
transcoding settings, for OvenMediaEngine the segment duration and count and the uploader's poll
interval. The field list is `common/src/engineSettings.ts`, and the page takes each setting's label,
unit, help, kind, bounds and choices from it, so the answer carries none of them.

- **Its value** is what the deployment stores in its engine settings, and **its default** is what an
  unset one falls back to on the deployment's host, as the Engine card names it: the host's base
  `.env` first, then the version's own fallback, except for the SRT latency, whose 2000 is the
  manager's own and is named as such.
- **A key the config the engine runs no longer reads**, because the deployment's own config file
  dropped its placeholder or the version's template never takes it, says on its row that a value
  there has no effect.
- **An engine setting the deployment does not read** is listed out of reach with the reason: a rung
  setting on a deployment that does not encode the ABR ladder, and a setting of the engine it does
  not run. A value stored for one before is listed so it can be reset.

A save puts an engine key in `profiles.engine_settings` and never in the stack columns. Each value is
held to its field, refused by key in the engine's own words. What the engine settings will be once the
save lands, the stored ones with its values set and its resets taken out, is then held to the
engine's own rules, with the host's default for a key nothing stores, so a pair the engine would
refuse, a force-close ceiling under the segment length or a frame rate and segment length whose
product is not whole, is refused with that sentence. A save that names no engine setting is not held
to them. The stack columns, the engine settings and the revision move in one statement, so a save
lands whole or not at all. Turning the ABR ladder off in the deployment's Edit drawer takes the rung
settings out of the engine settings by key, so a value saved from this card while that edit was on
its way stays.

The host can stop taking engine settings it took when they were saved: a change to its base `.env`
or to the version's own fallback can drop the ceiling under a saved segment length, and turning the
ABR ladder on can put a saved segment length under the keyframe rule. The deploy refuses such
settings with the engine's sentence, as it always has. The list still answers, with that sentence as
`engineSettingsProblem`, and the card names it above Save. A save that names no engine setting is
taken as ever, and one that names an engine setting is taken once it leaves them whole, which is how
they get fixed. Apply is refused with the sentence rather than starting a deploy that would fail on
it.

A save recreates nothing. Apply then recreates the containers that read what changed: the engine for
an engine setting, the engine and the uploader for the segment length, which both read, and the
uploader alone for the OvenMediaEngine poll interval, which only the uploader reads. That comes from
the same record of what each container got as for any key.

The engine settings route, `PUT /profiles/:name/engine-settings`, stays as the way scripts save and
recreate in one call. It always recreates the engine, and the uploader as well when a setting the
uploader reads changed, so for the poll interval it recreates both. It moves the same revision, and
it reads the stored settings with that revision before it writes, so it is refused with
`engine_settings_changed` when a save from the page landed in between, and a page that read before it
is refused with `deployment_settings_changed`. Neither save writes over the other unseen. Its body
replaces the whole set, so a key neither engine reads is refused with `validation_error`, named and
its value never repeated, and nothing is stored. Dropped, a misspelled key would have put the
setting it meant back to its default. An empty body still puts every setting back to its default.

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
- **not-running:** the deployment is stopped, or is deploying, stopping or being removed, so no
  container is compared.

Apply redeploys only the containers that are behind. When a changed key reaches the deploy scripts
alone, it redeploys everything. A stopped deployment's Start uses the stored values anyway, so Apply
refuses it. Apply is also refused, with the engine's own sentence, while the deploy would refuse the
stored engine settings.

A save stores and changes nothing that runs. It names the revision the page read, and a save made
against an older one is refused. So two operators editing at once cannot overwrite each other unseen.

## The shape a value may have

Every value answers to the rules of the version settings page, which keep out a value the stack's
loader and the manager's parser would read differently. For the keys whose accepted values are
certain, such as the start gate mode, the chequebook floor and re-check interval, the stamp limits,
the log level and format, and the switches, the value is also held to what the stack takes, in
`common/src/stackSettingFields.ts`: a number to the stream uploader's own bounds, and a choice or a
switch to the values the stack's samples name. Any other key is plain text, checked by its
container when it starts.

## API

`GET /profiles/:name/settings`, `PUT /profiles/:name/settings` and `POST
/profiles/:name/settings/apply`, the engine settings among them, and for a deployment not created yet
`GET /versions/:id/settings-catalog` and the `stack_settings` of `POST /profiles` and `POST /groups`,
all described in `manager/README.md` under "A deployment's own settings".

## The page

A deployment's page shows these settings in a **Stack settings** card after the Engine card, the
whole width of the main column. The Engine card's own settings drawer went on 2026-09-26. The card
keeps its list of what the engine runs with and where each value came from, and its **Settings**
button brings this card into view with the engine settings open and the first one focused. The SRT
ingest card's step to raise the SRT latency brings the card into view at that setting, focused.

The Engine card and the engine line of **At a glance** show the stored engine settings, so between a
save and Apply they name a value the engine does not run yet. The page reads the list once for this
card and both of those, and they mark every value whose key the running containers are behind on as
**saved, not applied**. A save that lands also reads the deployment's row again, because the manager
announces no change for a save, so both show the value it stored rather than the one before it.

- **Folded by the sample's sections**, in the order they first appear, with the deployment's own
  engine settings in an **Engine settings** section first and the keys the version no longer
  declares in a section of their own at the end. A section opens on a click, and a search by
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
- **An engine setting** is named by its label with the key beside it, says its field's help, and takes
  a number field with its unit and bounds or a list of its choices. Its default is beside it, with
  where it comes from: set on this host, the version's own, or the manager's own. A search finds it by
  its label and help as well as its key. A screen reader hears the field as its label and its key,
  then the line under it, which says the unit with the bounds and is read out when a refusal replaces
  it, then the default a reset goes back to.

A value the manager would refuse is named under its field, by the same shared rules, and keeps Save
off. A pair of engine settings the engine would refuse is named once above Save, in the manager's
words, and keeps Save off until the pair is whole. Stored engine settings the next deploy would
refuse are named there too, saying that Apply is refused and any other deploy fails until they
change, and keep no save back, so a save of other keys still goes through and so does the one that
fixes them. Save sends the changed keys in one request with
the revision the page read. A refused save shows the manager's sentence under the button. A save
refused because another one landed first says the settings changed elsewhere and reads them again,
and the change has to be made again.

Above the list, the banner names the settings the running containers are behind on and offers Apply,
and after Apply says what was recreated. When Apply recreates the engine, or redeploys everything, the
banner says a live publisher is disconnected for a few seconds, as Restart does, because the SRT
ingest card sends an operator here during a broadcast. On a stopped deployment it says what Start will use, with no
Apply. Where no container has a record to compare with, which is every deployment deployed before
this feature, the card says so, because no key of it can show as behind until its next deploy.

The editor is its own component, `frontend/src/deployments/settings/DeploymentSettingsEditor.tsx`,
and the card only frames it. It fits 390 pixels with no sideways scroll. `frontend/test/deployment-settings-browser.test.mjs`
drives it in Chrome, and the mock manager answers the three routes, so `pnpm -C frontend dev:mock`
shows it with no manager: main-stage is behind on a saved key, old-demo is stopped with one waiting
for its Start, and field-unit has no records to compare with.

## In the new-deployment wizard

A deployment is created with its settings already set. The wizard's settings step ends with an
**Advanced settings** fold, folded until opened, because most deployments keep every version
value. Its line says what it holds, and once values are typed, how many the create sends or which
value it cannot send.

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
  settings decide, shows the segment length typed above it, so the two never read differently. The
  engine settings are asked for in the wizard's own steps, so its list keeps every one of them out
  of reach, where the deployment's page, once it exists, lists them as its own.
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
- Right after a save the list and the deployment's row are read one after the other, so for the
  moment between the two answers the Engine card can mark the value from before the save. A page
  that another operator's save changed shows the old value, unmarked, until its row is read again.
- An engine setting's default is read from the host's base `.env` and the version's own fallback, as
  the Engine card reads it, and not from the engine's own env file, `engines/<engine>/.env`, which
  the version settings page can also set. Where that file sets an engine setting, an unset one
  falls back to its value rather than to the default named here.
- A key only some sections of a config file read is not flagged on its row, only one no section
  reads. The Engine card still shows each reading.
