# Custom RPC endpoint privacy regression

Status: done.

Recorded 2026-09-19 for `fix/main-v2-rpc-privacy`, based on `a5b4253`.

## Finding

Priority P1. A keyed custom RPC URL was likely to trouble every signed-in user
in normal use because profile reads, lists, group results and change events all
carried the full stored URL. The edit page also put that value in a plain text
field. Fixing it touches the profile projection and the private deployment read.
Accepting it exposes a reusable credential to browsers, proxies and event
consumers. Fix before shipping.

## Red evidence

The focused manager regression failed because `PROFILE_COLUMNS` selected
`rpc_endpoint`, omitted the public presence and host fields, and serialized
`synthetic-key` in create, group and event results.

```text
bash /Users/kisslevente/Documents/git/estate/tools/lane.sh --name infra-rpc-privacy -- pnpm --dir manager exec tsx --conditions=development --test test/unit/profileSql.test.ts test/unit/rpcEndpointPrivacy.test.ts
```

The focused frontend regression failed because an unchanged stored custom
endpoint with an empty secret field was rejected as missing.

```text
bash /Users/kisslevente/Documents/git/estate/tools/lane.sh --name infra-rpc-privacy -- pnpm --dir frontend exec tsx --conditions=development --test src/forms/deploymentEdits.test.ts
```

## Green evidence

The manager privacy test covers create, read, list, group results, profile
events, omitted URL preservation, replacement, an explicit clear and a
source-only clear. The deployment env test uses the orchestrator and reads the
written env file after an unrelated edit to prove the stored URL still reaches
the deployment. The SQL test holds the public projection. The redaction test
holds the private log path.

The frontend form test covers an empty initial secret field, unchanged custom
preservation, a typed replacement and a source switch. The offline manager HTTP
test covers public presence and host metadata, absence of the raw property,
group responses and a source-only switch.

## Limits

No database test ran locally because this checkout has no configured disposable
PostgreSQL mapping. On 2026-09-19, [run 35440997869](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35440997869)
tested `e88581a42483e8caf7fa6a3ca41b5492a8b74f1e` in the PR workflow's disposable
databases. All 547 database tests passed, including the public projection,
omission preservation, replacement and group cases in
`manager/test/database/profileNodeMode.test.ts`. Build, typechecks and the
complete unit, native and browser suites passed on that commit too. This is
automated test evidence, not a live host result.

## Backslash boundary follow-up

An independent review found that the application URL parser treats a backslash
after an HTTP host as a slash, while the SQL host projection did not. The
focused SQL test went red for
`https://rpc.example.org\synthetic-key`, because the public metadata could
contain `rpc.example.org\synthetic-key`.

The projection now converts backslashes to path separators before it extracts
the host. The focused SQL and privacy files pass 14 tests. The disposable
PostgreSQL test also persists this exact shape and checks find, list, group
create and group list projections against the private endpoint reader. It was
not run locally for the database mapping reason above. It passed in the
completed PR database run cited above.

## URL userinfo follow-up

Copilot comment `4053142114` identified a P1 gap on 2026-09-19. A stored URL
containing `synthetic-user:synthetic-secret@rpc.example.org` produced the
userinfo as public host metadata. The database accepts this URL shape, so
request validation alone cannot protect existing rows. A small projection
correction is preferable to exposing stored credentials to profile readers.

The repository regression failed in [run 35442940317](https://github.com/Solar-Punk-Ltd/streaming-infra-manager/actions/runs/35442940317)
at `b4edc3c824245f2b251f564155b55b69d9bdadec`. PostgreSQL returned
`synthetic-user:synthetic-secret` instead of `rpc.example.org`. This was the only
failure among 548 database tests, with zero skips.

The projection now extracts the complete authority after normalizing backslash
boundaries, removes everything through the last `@`, and returns null for an
empty remainder. Matching the complete authority prevents an incomplete URL
from falling back to a credential prefix. The exact private URL stays stored.

The regression exercises profile insert, find, list and update responses,
group creation and member lists, plus exact private endpoint reads. Its six
synthetic inputs cover ordinary userinfo, encoded userinfo with multiple `@`
characters, IPv6 with a port, and empty-host forms ending at a slash, a query
or the end of the URL. The earlier backslash regression remains in the suite.
The current result is recorded in PR 42's database check for each pushed commit.
