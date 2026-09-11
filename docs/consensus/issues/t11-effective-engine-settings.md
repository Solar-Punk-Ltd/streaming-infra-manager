# T11. Use one source of effective engine settings

Source: R11. Priority: P2. Depends on: nothing. Decision: none. Size: S. Ready first.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

`frontend/src/deployments/engineText.ts:26` calls `effectiveEngineSettings` without the version's defaults, and `AtAGlanceCard.tsx:51` shows the result, so a main-v3 deployment reads 1.5 and 22.5 where the engine runs 0.5 and 15.

## Scope

- The manager answers `effective_engine_settings` on each profile, computed from the version's defaults (`ProfileService.engineDefaults` at :431), host overrides and deployment overrides. Every surface reads it: engine card, At a glance, editor help, generated config.
- For a custom config file, report parsed values with their source when reliable. A key omitted from the file is reported as omitted with the effective value unverified, never as "set by the file". The running config under Logs remains the truth.

## Acceptance

- For the observed main-v3 defaults the engine card, At a glance, editor help and generated config agree on 0.5 and 15, against 1.5 and 22.5 on the bundled version.
- An explicit override followed by clearing it returns every surface to the correct default.
- Host overrides, bundled defaults and supported OME settings have regression coverage.

## Where the design lives

PRD "**T11.**" in Fable round 1 section 5, OpenAI round 2 section 4, T11 line of "Question 8" in Fable round 2.

## Code anchors

common/src/engineSettings.ts effectiveEngineSettings :278 and the placeholder map :197 and :209, common/src/engineConfig.ts:89, ProfileService.ts:431, frontend deployments/engineText.ts :22 to :39, AtAGlanceCard.tsx:51.
