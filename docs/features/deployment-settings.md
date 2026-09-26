# A deployment's own settings

Status: the store, the record of what each container got, and the API, as of 2026-09-26 on
`feat/deployment-settings-api`. The page that edits them comes next.

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

## Limits

- The stack's sample has no section rule closing "Per-rung Bee nodes", so the start gate settings
  that follow it are listed under that section until the sample gains one.
- A deployment deployed before this feature has records that cannot tell, so its keys read unknown
  until its next deploy.
