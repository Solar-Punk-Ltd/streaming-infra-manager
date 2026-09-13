/**
 * No slot up to the cap can take a deployment.
 *
 * Two different things read the same from the allocator, which only ever sees
 * that it found nothing: every slot is occupied, or none of them passes the
 * port policy in the first place. The second is not a full machine and a
 * reason is passed in for it, because "remove a deployment to free one" then
 * costs an operator a working deployment and does not help. It happened on the
 * live host on 2026-09-13, where six slots of ninety nine were in use.
 */
export class AllSlotsUsedError extends Error {
  constructor(public readonly slotCap: number, reason?: string | null) {
    super(
      reason ??
        `Every port slot from 1 to ${slotCap} is taken, by a deployment record or by ports another deployment holds on this daemon. Remove a deployment to free one.`,
    );
    this.name = 'AllSlotsUsedError';
  }
}
