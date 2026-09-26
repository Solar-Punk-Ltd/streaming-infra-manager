/**
 * A create asked for the manager's stored web2 admin token for an address on
 * another origin than the one the token was saved with, or for no address,
 * so no deployment was created. The stored token goes only to the address it
 * was saved with.
 */
export class ManagerAdminTokenElsewhereError extends Error {
  constructor() {
    super(
      "The manager's stored web2 admin token was saved for another address than this deployment's ADMIN_API_URL, and it goes only to the address it was saved with. Type a token for this address, or use the address saved on Manager settings.",
    );
    this.name = 'ManagerAdminTokenElsewhereError';
  }
}
