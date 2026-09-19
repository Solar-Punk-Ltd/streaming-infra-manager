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
PostgreSQL mapping. `manager/test/database/profileNodeMode.test.ts` records the
database projection, omission preservation, replacement and group behavior for
the verification server. Full typecheck, build and suite verification are also
left to that server under the repository's verification rule.
