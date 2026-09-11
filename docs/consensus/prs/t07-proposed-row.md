# fix: an edit is judged on the state it proposes, and a silent node refuses the start (T07)

Branch `fix/t07-proposed-row`, five commits on top of main-v2 at d046ebf. Not pushed. Row T07 of the consensus set, see `../issues/t07-validate-proposed-state.md`. Decision D02 applied as decided.

## What was wrong

`ProfileService.update` handed the stored row to the uploader gate and to the deploy claim, then wrote and deployed the new one. So a dead stamp could not be replaced through Edit, because the gate refused the stamp being replaced, and a live stamp let a dead replacement through, because the gate never saw it. A group edit did the same for every member. Separately, both gate checks let a node that did not answer through, with a notice on screen that the uploader had started unchecked, which looks exactly like a checked start until nothing it uploads lands.

## What changed

- The edit builds the proposed row once, with a field the body leaves out already null the way the PUT stores it, and hands that same row to the gate, the claim, the write and the deploy. The Bee target check reads the proposed row too.
- A group edit builds one proposed row per member and claims each for that row. A member the gate refuses gives every claim already taken back and changes nothing, as before for a busy member.
- The chequebook check refuses a node that does not answer, and a balance that cannot be read, with a message naming the node and saying to try again once it answers. The stamp check refuses a node that does not answer the same way. Both answer 502 `bee_node_unreachable`, the status a node that cannot be asked already had elsewhere. Nothing is published as "started without checking" any more, and the helper that built that text is gone.
- Engine-only recreates never ask the gate and a stopped deployment's start does not either, so a deployment whose node is down can still be recreated engine-only or stopped and started. A full redeploy of a running deployment whose own node is down is now refused, which is the trade D02 made.

## Commits

1. `6634b79` test: an edit is judged on the state it proposes, and a silent node refuses the start. Eight fail on purpose. The recording orchestrator gains a gate and keeps the rows it was handed.
2. `8c11881` fix: an edit is judged, claimed and deployed on the row it proposes
3. `50e778e` fix: a chequebook check the node does not answer refuses the start, as D02 decided
4. `fee1268` test: a stamp check the node does not answer refuses the start, and a known batch still passes. One fails on purpose.
5. `498a447` fix: a stamp check the node does not answer refuses the start, as D02 decided

## Test evidence

| # | Guarantee | Where | Before | After |
| --- | --- | --- | --- | --- |
| 1 | A dead stamp is replaced by a live one through Edit, the gate seeing the live one | `proposedRow.test.ts` | fail | pass |
| 2 | A dead stamp in place of a live one is refused before any claim, and the row, its status and its notes stay | same | fail | pass |
| 3 | The gate, the claim and the deploy get one and the same state, a left-out field already null | same | fail | pass |
| 4 | A group edit shows the gate the proposed stamp for every member | same | fail | pass |
| 5 | A refused member writes and deploys nothing and gives the earlier claims back | same | fail | pass |
| 6 | A chequebook check the node does not answer is refused with the retry in words, and no notice is published | `chequebookService.test.ts` | fail | pass |
| 7 | A balance that cannot be read is refused | same | fail | pass |
| 8 | A stamp check the node does not answer is refused with the retry in words, a known batch still passes, an unknown one is still not usable | `stampStartCheck.test.ts` | one fails | pass |

`cd manager && pnpm test` 499 pass, `pnpm typecheck` clean, `cd common && pnpm test` 261 pass.

## Merge note

`ProfileService.update` is also changed on `fix/t19-notes-route` (the notes revision guard). Whichever of the two merges second will conflict in that method. Say which goes first and the other gets rebased.

## Not done here

The Bee target a deployment publishes through follows its components, which the PUT cannot change, so the target the gate asks about is by construction the one the proposed row runs. The frontend's error display for the new 502 is the existing one. Nothing here touches the host or any deployment.
