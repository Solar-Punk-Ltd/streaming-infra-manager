# The main-v2 review consensus and its acceptance trail

What this directory is: the written record of the cross-provider review of `main-v2` at `d046ebf`, the 25-row remediation set it produced, and the acceptance trail of the work on those rows. Fable (Anthropic) and Codex (OpenAI) debated the review to consensus with Levi relaying, then both implemented rows on local branches, and Codex merged the 22 finished heads into `feat/ai-remediation` on 2026-09-09. The narrative of that merge is `../handover/main-v2-remediation.md`.

These files were written under `.scratch/main-v2-review-consensus/`, which stays untracked and keeps the originals together with the logs and browser evidence. They were copied here unchanged on 2026-09-09 so the pull request carries the record. The directory sits two levels below the repository root on purpose: every relative link inside these files, such as `../../manager/src/domain/ProfileService.ts`, resolves the same way it did in the scratch directory.

| File or directory | What it holds |
| --- | --- |
| `PRD.md` | The whole review, every round from both sides, Levi's decisions D01 to D10, and the final task table. When a row's design is needed, its section is here. Revision consensus-13. |
| `issues/` | One file per row, T01a to T22, with scope, acceptance text and dependencies, as drafted for the issue tracker. Never posted anywhere. |
| `prs/` | One draft per row of the pull request body it would have had, with its test evidence. Superseded as pull requests by the single integration PR, kept as the per-row record of what was built and checked. |
| `ACCEPTANCE-AUDIT.md` | Which acceptance conditions were met at which commit, and which remain open, as audited during the work. |
| `T01-CONTINUATION.md` and the other `T*-CONTINUATION.md` files | The working contract of each larger row: the boundaries agreed between reviewer and implementer, the RED and GREEN evidence, and the obligations left. The newest paragraphs supersede the older ones where they disagree. |
| `T04B-COMMAND-BRIEF.md` | The implementation brief for the bundled publication command, the first slice built after the merge. |

Left out on purpose: the two handover notes that the tracked handover replaced, the parallel work plan, the merge logs under `local-merge/`, and the evidence directory with about a thousand test logs, browser captures and copied Bee sources. Log paths cited in these files, such as `/private/tmp/t08-sql-approval-r2.log`, now live under `.scratch/main-v2-review-consensus/evidence/private-tmp/` with the same file names.
