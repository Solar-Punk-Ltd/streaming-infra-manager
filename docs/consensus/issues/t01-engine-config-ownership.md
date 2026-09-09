# T01. Give engine configuration rollouts explicit ownership

Source: R01. Priority: P1. Depends on: T01a. Decision: none. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

The watch after a config-file apply is attached to the deploy script's `done` event (EngineConfigService.ts:199), the previous file lives in a closure (read at :144, before the claim), and a revert writes the previous file and then claims the deployment (:233 to :256). A delayed watcher can undo a newer save, a manager restart loses the rollback target, and a stopped deployment can be recreated by an old watcher.

## Accepted design, in short

- `profiles.instance_id` (UUID at insert), `profiles.engine_config_revision` (bumped by every write of the config column, every write takes an expected revision), `profiles.intent_revision` (bumped by every operator action: apply, reset, stop, start, edit, remove).
- Table `engine_config_operations`: profile, instance, engine, kind (apply or reset), `previous_config` with `previous_is_template`, applied revision, intent revision, state, timestamps, message, and the observed container id and `StartedAt` recorded at watch start. States: applying, watching, applied, reverting, reverted, failed, interrupted, superseded. One open operation per instance (partial unique index). A new apply or reset supersedes the open one in the transaction that stores its own file. Stop's transaction supersedes any open watching or acting operation. An interrupted operation stays open and is superseded only by an operator action on it, a new apply or reset, or removal.
- The watch starts from the orchestrator's success hook after RUNNING is committed, through a callback handed to `runReserved`, never from the script's `done` event.
- Every tick re-reads the row and ends without acting when the operation is not watching, the instance differs, the status is not RUNNING, or a revision moved.
- A revert is one transaction: take the deploy claim, check state, instance, status, config revision and intent revision together, write `previous_config` with the expected revision, mark reverting. A refused claim ends the operation as superseded with a message and writes nothing else.
- A non-zero recreate exit runs the same owned recovery transaction: failed, previous file back, one recreate attempted, both messages kept. If B or Stop took ownership meanwhile: superseded, no write, no launch. If the recovery recreate fails too, the deployment stays ERROR and the operation says so.
- Completion is conditional: the applied write requires the operation still watching with the same instance and revisions.
- Boot: applying becomes interrupted ("Apply interrupted by a manager restart. The file is stored, the engine was not verified." with verify now and back to the previous file). Watching with the same container id, running, restart count zero: a fresh full watch. Same id but restarted or not running: revert through the owned path. Different id: superseded. Inspection impossible: interrupted. Reverting stays open ("Recovery interrupted. The previous file is stored, the engine was not verified." with recreate on the previous file and verify now, both new operations that supersede the old one first). Timestamps are supporting evidence only. An outage is never a pass.
- The card distinguishes applying, verifying, applied, reverted with the reason, apply failed with the previous file back, apply failed and recovery failed, and the interrupted states.

## Acceptance

- Applying A then B cannot let A's delayed watcher replace B or recreate B's container. Stop, Start and service reconstruction cannot revive A. Save followed by reset, stop followed quickly by start, deletion followed by reuse of the same name.
- A healthy matching container that started before Compose completed is recognised at boot.
- Restart before the recovery spawn and after the recovery container was created both leave an explicit unresolved recovery, never a silent strand or an unbounded retry.
- A failure callback that lost ownership to B or Stop makes no write and launches nothing.
- A final healthy tick cannot mark a superseded operation applied.
- An interrupted operation cannot act on a removed and recreated instance.
- A losing expected-revision write changes nothing. The template (null) target is restored only while the operation owns the claim.
- Controlled-clock tests in engineConfigService.test.ts. The container-backed startup failure belongs to T20's Docker job.

## Where the design lives

PRD "**Question 2, T01's durable state**" (Fable round 2), "##### Question 2. T01 persisted operation and restart rule" (OpenAI round 3), "##### Question 2, T01" (Fable round 3), "##### Question 2. T01 and T01a" (OpenAI round 4).

## Code anchors

EngineConfigService.ts apply :123 to :150, storeAndRecreate :166 to :195, watchAfter :197 to :211, watchEngine :219 to :235, revert :237 to :256. DeploymentOrchestrator.ts REDEPLOYABLE_FROM :102, runReserved :289. ProfileRepository.ts resetOrphanedTransitions :307. Migrations under manager/src/migrations (latest 012).
