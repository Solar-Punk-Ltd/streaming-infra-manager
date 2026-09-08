import { PORT_POLICY_VERSION, portExposureProblem, publicPortRole } from '../../common/src/portPolicy.js';

const key = row => row.protocol + '/' + row.port;
function requireEvidence(condition, reason) {
  if (!condition) throw new Error('Inventory evidence: ' + reason);
}
const text = value => typeof value === 'string' && value.length > 0;
const tuple = row => row && ['tcp', 'udp'].includes(row.protocol) && Number.isInteger(row.port) && row.port >= 1 && row.port <= 65535;

/** Checks the exported snapshot's internal coverage. This does not authenticate a file or query the current host. */
export function validateInventory(value) {
  requireEvidence(value && value.schemaVersion === 1 && value.policyVersion === PORT_POLICY_VERSION, 'unsupported inventory or policy version.');
  requireEvidence(text(value.daemonId) && text(value.capturedAt) && Number.isFinite(Date.parse(value.capturedAt))
    && /^[0-9a-f]{64}$/.test(value.fingerprint), 'missing capture identity.');
  for (const field of ['profiles', 'claims', 'reservations', 'bindings']) {
    requireEvidence(Array.isArray(value[field]), 'missing ' + field + '.');
  }
  const profiles = new Set();
  for (const profile of value.profiles) {
    requireEvidence(profile && text(profile.name) && Number.isInteger(profile.slot) && profile.slot >= 0
      && text(profile.target) && Number.isInteger(profile.versionId) && text(profile.status), 'invalid profile.');
    requireEvidence(!profiles.has(profile.name), 'duplicate profile.');
    requireEvidence(!['DEPLOYING', 'REMOVING', 'STOPPING'].includes(profile.status), 'a deployment operation is in progress.');
    profiles.add(profile.name);
  }
  for (const claim of value.claims) {
    requireEvidence(tuple(claim) && profiles.has(claim.profileName) && text(claim.portVar)
      && text(claim.service) && Number.isInteger(claim.versionId) && /^[0-9a-f]{7,40}(-r[1-9][0-9]*)?$/.test(claim.buildId), 'invalid retained claim.');
    requireEvidence(!portExposureProblem(claim), portExposureProblem(claim));
  }
  const covered = (row, service) => value.claims.some(claim =>
    claim.profileName === row.profileName && claim.service === service && key(claim) === key(row));
  for (const name of profiles) {
    requireEvidence(value.reservations.some(row => row.profileName === name)
      && value.claims.some(claim => claim.profileName === name), name + ' has no retained reservation coverage.');
  }
  for (const reservation of value.reservations) {
    requireEvidence(tuple(reservation) && text(reservation.profileName) && reservation.daemonId === value.daemonId
      && Array.isArray(reservation.heldServices), 'invalid reservation or daemon.');
    if (profiles.has(reservation.profileName)) {
      requireEvidence(reservation.heldServices.length > 0
        && reservation.heldServices.every(service => text(service) && covered(reservation, service)), 'reservation has no retained owner coverage at ' + key(reservation) + '.');
    } else {
      requireEvidence(!publicPortRole(reservation), 'unknown owner of public ' + key(reservation) + '.');
    }
  }
  for (const claim of value.claims) {
    requireEvidence(value.reservations.some(row => row.profileName === claim.profileName && key(row) === key(claim)
      && row.heldServices.includes(claim.service)), 'claim has no matching reservation at ' + key(claim) + '.');
  }
  for (const binding of value.bindings) {
    requireEvidence(tuple(binding) && (binding.project === null || text(binding.project))
      && (binding.service === null || text(binding.service)), 'invalid observed binding.');
    if (publicPortRole(binding) || profiles.has(binding.project)) {
      requireEvidence(value.claims.some(claim => claim.profileName === binding.project && claim.service === binding.service
        && key(claim) === key(binding)), 'observed binding has no compatible retained claim at ' + key(binding) + '.');
    }
  }
  return value;
}
