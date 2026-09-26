/**
 * A create asked for the manager's stored web2 admin token, and at its insert
 * the manager stored none, so no deployment was created.
 */
export class ManagerAdminTokenMissingError extends Error {
  constructor() {
    super('The manager stores no web2 admin token to copy into this deployment. Type a token for it, or save one on Manager settings.');
    this.name = 'ManagerAdminTokenMissingError';
  }
}
