# T05a. Serialise shared-tag builds and guard container creation per project

Source: R04, reproduced locally (7 of 32 container creations ran the wrong content, PRD Fable round 1 section 3 and round 2 section 3). Priority: P1. Depends on: nothing. Decision: none. Size: M.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## What is wrong

The stack fixes `image: stream-uploader` and `image: stream-client`, every deploy runs `up -d --build`, deploy jobs return at spawn, and group members start back to back. Two projects race on one tag and a container can be created from the other project's image. The api image installs `docker-cli-compose` unpinned (manager/Dockerfile:39 to :43). Host facts, read by Levi: Engine 29.1.3, api Compose v5.1.4.

## Accepted design, in short

- Contract flag `sharedImageTags`: true when a built service declares an `image:` name, and an unreadable classification counts as shared. The Versions page shows it.
- `deploy_locks(daemon_id, kind, job_id, profile, acquired_at, heartbeat_at)`: one durable lock per daemon for shared-tag jobs, held through Compose's completion. Every deploy path (initial, group, recreate, restart) goes through `runJob`, where the lock is taken.
- A durable creation guard per daemon and Compose project, taken by every attempt, legacy or fixed-image, in the same transaction that captures the project's pre-job container id set (all states) on the verified daemon, before anything is spawned. Checked at every admission for that project, whatever the flag or the profile's status says, including after a restart and after a name is reused.
- Release: automatically only when every service the attempt touched has a container id absent from the pre-job set. Otherwise the attempt is blocked, the row records job, profile and reason, every deploy of that project (and every legacy deploy on that daemon for the daemon lock) is refused with that reason, the Versions and deployment pages say which attempt holds it, and a typed operator release naming the job, after checking the host, is the way out. Elapsed time and unchanged image ids are diagnosis only, never a release. A no-op recreate stays blocked. Docker's own restart keeps a container id.
- Other projects are unaffected: fixed-image jobs run concurrently, legacy jobs queue on the daemon lock. The daemon id comes from `docker info` and is shared with T06's `deploy_targets`.
- The api image's Compose is recorded and pinned.
- Harness: the R04 script, in isolation against Engine 29.1.3 and Compose v5.1.4, never on the host. Assert subprocess exit codes and exact content including the nonce, classify missing containers and failed builds apart from wrong content, keep a controlled interleaving test beside the bounded shared-tag control, keep the failing shared-tag control beside the corrected variant, confine cleanup to the run's own resources.

## Acceptance

- Two concurrent deployments from different source SHAs run their intended image ids and contents. Two viewers at one SHA with different owner and topic keep their own configuration.
- A's lock persisted, a fake exporter paused past any window, the manager replaced, a controlled clock advanced, no service container of A: B stays outside the conflicting section until A is reconciled or released by hand. A's delayed export landing between B's build and create demonstrates why time cannot release.
- An unresolved job with old container ids carrying later creation times from an ahead remote clock stays blocked. Genuine new ids for every touched service release it.
- A's pre-job set and unresolved export persisted, a restart to ERROR, a fixed-image version published, B requested for the same project: refused or held until A resolves. A fixed-image job for another project is allowed. B proceeds after A resolves. A reconciler fixture where the new ids belong to B never counts them as A's completion. The same sequence with A on a fixed-image version has the same outcome.
- Group and initial deploy paths and a classification failure are covered. Unknown never means safe to run concurrently.

## Where the design lives

PRD "##### Question 6. T05 interim serialization" (OpenAI round 3), "##### Question 6, T05" (Fable round 3), "##### Question 2, T05a" (Fable rounds 4 and 5), "##### Question 2. T05a" (OpenAI rounds 5 and 6), "##### Question 1, T05a" (Fable round 6), OpenAI round 7. Script text: Fable round 2 section 3.

## Code anchors

DeploymentOrchestrator.ts runJob :571 to :616, buildScriptArgs :651 to :667, REDEPLOYABLE_FROM :102. ScriptRunner.ts :67 and :85. ProfileRepository.ts:307. versions/stackContract.ts. manager/Dockerfile:39 to :43, manager/docker-compose.yml:36 to :46.
