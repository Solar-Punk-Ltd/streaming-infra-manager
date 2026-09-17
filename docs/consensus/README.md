# The main-v2 review consensus and its acceptance trail

What this directory is: the written record of the cross-provider review of `main-v2` at `d046ebf`, the 25-row remediation set it produced, and the acceptance trail of the work on those rows. Fable (Anthropic) and Codex (OpenAI) debated the review to consensus with Levi relaying, then both implemented rows on local branches, and Codex merged the 22 finished heads into `feat/ai-remediation` on 2026-09-09. The narrative of that merge is `../handover/main-v2-remediation.md`.

The review files, the issue drafts, the pull request drafts and the continuations were written under `.scratch/main-v2-review-consensus/`, which stays untracked and keeps the originals together with the logs and browser evidence. They were copied here unchanged on 2026-09-09 so the pull request carries the record. Everything in the second table below was written here from the start. The directory sits two levels below the repository root on purpose: every relative link inside these files, such as `../../manager/src/domain/ProfileService.ts`, resolves the same way it did in the scratch directory.

Where the work stands: `feat/ai-remediation` is merged into `main-v2`, and it was deployed to the live test host on 2026-09-11 along with its one-way migration and a signed-in pass. What that session found is the dated section at the end of `../handover/main-v2-remediation.md`. Everything in this directory is therefore a record of finished work rather than an instruction, and each file now says so on its own first lines. The rows added on 2026-09-17 under `issues/` are the exception, open work rather than record: T23's host measurement and T27, ruled and being built. T25's stack half was merged and pinned the same day. Read a brief for what was asked and a fixes file for what the reviewers measured, and treat the branches, worktrees, commits and line numbers inside them as the state at the time of writing.

How to follow an evidence citation: these files cite their logs by the path they were written to at the time, `/private/tmp/<name>.log`. Those logs live under `~/Documents/estate-state/evidence/streaming-infra-manager/main-v2-review-consensus/evidence/private-tmp/` on the machine the work was done on, with the same file names, so read the last path segment and look for it there. They moved there from the repository's untracked `.scratch/main-v2-review-consensus/` on 2026-09-16, and a tombstone at that old path says so. Either way a citation cannot be followed from a fresh clone.

| File or directory | What it holds |
| --- | --- |
| `PRD.md` | The whole review, every round from both sides, Levi's decisions D01 to D10, and the final task table. When a row's design is needed, its section is here. Revision consensus-13. |
| `issues/` | One file per row, 30 of them, T01 through T27 with T01a and the a/b splits among them, the last five added on 2026-09-17, with scope, acceptance text and dependencies, as drafted for the issue tracker. Never posted anywhere. Its own `issues/README.md` explains the file shape. |
| `prs/` | One draft per row of the pull request body it would have had, with its test evidence. Superseded as pull requests by the single integration PR, kept as the per-row record of what was built and checked. |
| `ACCEPTANCE-AUDIT.md` | Which acceptance conditions were met at which commit, and which remain open, as audited during the work. |
| `T01-CONTINUATION.md` and the other `T*-CONTINUATION.md` files | The working contract of each larger row: the boundaries agreed between reviewer and implementer, the RED and GREEN evidence, and the obligations left. The newest paragraphs supersede the older ones where they disagree. |
| `FIRST-DEPLOY-SESSION.md` | The runbook for the first real deploy of this branch and the signed-in live test after it. That session ran on 2026-09-11. The host inventory in it describes the host before the deploy, not after. |

## The slices built after the merge, in order

Each slice has a brief written before the work and, where reviews followed, a fixes file listing what they found and what changed. Read the brief for what was asked and the fixes file for what the reviewers measured. The dated sections of `../handover/main-v2-remediation.md` narrate the same slices in the same order.

| File | What it holds |
| --- | --- |
| `T04B-COMMAND-BRIEF.md` | The bundled publication command: a laptop-side seal, a host-side upgrade, the deploy script wired to both. Superseded in part by the bundled-on-host slice below, which removed the seal and the package. |
| `T04B-COMMAND-FIXES.md` | What two reviews of that slice found, and the fix for each. |
| `BUNDLED-ON-HOST-BRIEF.md` | Decision D12: the bundled version stops arriving with the deploy. The host fetches and builds the pinned commit itself. Also records D11, one private execution copy per deployment, for the exact-execution slice, which was built later and is the last row of this table. |
| `BUNDLED-ON-HOST-FIXES.md` | The security and correctness reviews of that slice, and the targeted re-review after them. |
| `VERSION-SETTINGS-BRIEF.md` | Decisions D12 and D13: a settings page for every version's own files, with the secret-like values revealable and settable by hand. |
| `VERSION-SETTINGS-FIXES.md` | The two reviews and the targeted re-review of that page. It also records D14, whether these settings become admin-only, which is open for Levi. |
| `T09-COMPLETION-BRIEF.md` | Receipt polling, a portable browser harness and the connected acceptance suites for the money flow. |
| `T09-COMPLETION-FIXES.md` | What the two reviews of that slice found. |
| `T20-COMPLETION-BRIEF.md` | Checks that run what the repository claims: the SQL, browser and native suites given jobs, and entry points for the container-backed regressions. |
| `T20-COMPLETION-FIXES.md` | The reviews of that slice, including the unit test that was writing into the real stack checkout. |
| `T21-COMPLETION-BRIEF.md` | This documentation reconciliation: what to check against the code, and the rule that a thing that has not run is said to have not run. |
| `EXACT-EXECUTION-BRIEF.md` | Decision D11 built: every deployment runs from its own private copy of its build, so a build is never written into. The last engineering slice of the roadmap, merged on 2026-09-11 and exercised on the host the same day. |

Left out on purpose: the two handover notes that the tracked handover replaced, the parallel work plan, the merge logs under `local-merge/`, and the evidence directory with about a thousand test logs, browser captures and copied Bee sources. Log paths cited in these files, such as `/private/tmp/t08-sql-approval-r2.log`, live under `~/Documents/estate-state/evidence/streaming-infra-manager/main-v2-review-consensus/evidence/private-tmp/` with the same file names, since the move of 2026-09-16.
