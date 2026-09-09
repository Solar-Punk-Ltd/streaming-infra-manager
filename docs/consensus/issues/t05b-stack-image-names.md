# T05b. Project-scoped image names in the stack

Source: R04. Priority: P1. Depends on: T05a for the harness. Decision: D09 decided, these are Levi's commits. Size: S plus S.

Baseline d046ebf, branch main-v2. Design and acceptance text: ../PRD.md (revision consensus-13). Every row was approved by both reviewers (OpenAI round 7), and Levi authorised implementation on 2026-09-07.

## Scope

- In the stack repository (Levi's): remove `image: stream-uploader` (deploy/docker-compose.yml:63) and `image: stream-client` (:104), so Compose names images `<project>-<service>`. Give `clean.sh` (:116 to :118) `down --rmi local`, after verifying on the supported Compose version that it removes only images without a custom tag, preserves other deployments' images and all node data, and is never a host-wide prune.
- A commit on main-v3, then a bump of the bundled submodule on main-v2. No automatic restart of a running deployment: a bump changes what the next deploy runs, never a running one.
- In the manager: the bundled pointer bump, and the Versions page says which registered versions still build shared tags. A warning is interim information, not proof that legacy concurrency is safe, which is what T05a's lock is for.
- The change is drafted locally and handed to Levi. It is never applied to review-20260907.

## Acceptance

- T05a's harness passes on the corrected variant while the shared-tag control still fails.
- Existing deployments and rollback targets keep usable images. Cleanup does not delete referenced artifacts.

## Where the design lives

PRD "**T05.**" in Fable round 1 section 5, OpenAI round 2 section 4, "##### Question 6, T05" (Fable round 3), decision D09.
