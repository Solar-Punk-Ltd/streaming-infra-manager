/**
 * A write that did not come from the manager's own pages. Either it was missing
 * the header a cross-origin page cannot add, or its Origin named another site.
 */
export class CrossSiteRequestError extends Error {
  constructor(public readonly reason: string) {
    super(`Refused a cross-site request: ${reason}`);
    this.name = 'CrossSiteRequestError';
  }
}
