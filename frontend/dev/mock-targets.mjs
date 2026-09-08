import { send } from './mock-http.mjs';

/** Offline fixtures only. No Docker or SSH connection is made by these routes. */
export function createTargetRoutes(readBody) {
  let inventorySeededAt = null;
  const targets = new Map([['localhost', {
    alias: 'localhost', daemonId: 'offline-local-daemon', verifiedAt: new Date().toISOString(),
    inventorySeededAt: null, lastError: null,
  }]]);
  return [
    ['GET', /^\/targets$/, (_req, res) => send(res, 200, { targets: [...targets.values()], inventorySeededAt })],
    ['POST', /^\/targets\/inventory$/, (_req, res) => {
      inventorySeededAt = new Date().toISOString();
      for (const target of targets.values()) {
        if (target.verifiedAt) target.inventorySeededAt = inventorySeededAt;
      }
      send(res, 200, { inventorySeededAt });
    }],
    ['POST', /^\/targets\/verify$/, async (req, res) => {
      const { alias } = await readBody(req);
      if (typeof alias !== 'string' || !alias.trim()) {
        send(res, 400, { error: 'validation_error', errors: ['Enter the deploy target to verify.'] });
        return;
      }
      const name = alias.trim();
      const failed = name === 'unreachable';
      const now = new Date().toISOString();
      const target = {
        alias: name, daemonId: failed ? null : `offline-${name === 'localhost' ? 'local' : 'remote'}-daemon`,
        verifiedAt: failed ? null : now, inventorySeededAt: failed ? null : now,
        lastError: failed ? 'This offline target simulates an unreachable Docker daemon.' : null,
      };
      targets.set(name, target);
      if (failed) send(res, 409, { error: 'target_not_verified', message: target.lastError });
      else send(res, 200, { target });
    }],
  ];
}
