# Bind Tested approval and wizard defaults to the displayed build

A stale Tested click could approve a newer build, and the wizard silently chose the first version when no default existed. Approval now names the displayed commit and immutable build id. The database checks both identities, layout and Ready status in the write itself.

Branch: `fix/t08-tested-approval`, reviewed checkpoint `347c7dd61cc26c00f9f41af00da50455b0d3c8fd`. T04a is merged. Local draft only.

Legacy rows keep commit-bound approval only while their layout is explicitly legacy and their build id is null. Bundled refresh and updates invalidate approval when identity changes. Migration022 records when approval was actually lost, without inventing historical dates. Reapproval and manual withdrawal clear that date.

An untested default stays selected with its recorded update warning visible in Basics and Review. With no default, the operator must choose explicitly. If versions arrive late or a selection disappears, a usable selector stays visible. A new default does not overwrite an explicit choice or reset the draft.

Validation at the completion checkpoint passed 574 manager tests, 265 shared tests, nine offline browser/helper tests and workspace types. The final selector correction passed ten browser/helper tests and frontend types. The browser covers actual approval payloads, withdrawal, legacy identity, delayed version loading, selection removal and the dated warning. Owned browser resources were cleaned.

All eight PostgreSQL regressions pass at `347c7dd`, including publication between service read and write and actual lock waiting. Log: `/private/tmp/t08-sql-approval-r2.log`. The explicitly approved disposable local database contained synthetic schemas and was removed afterward. T18's VersionCard integration preserves these semantics and is reviewed separately at `5f835ca`.

Cross-provider review, OpenAI-hosted. The lead inspected the committed completion in a separate checkout, reviewed its SQL predicates and browser evidence, and ran the eight real database tests. This approves T08's scope. Project-wide integration and other rows retain their own acceptance requirements. Nothing was pushed or merged into main-v2.
