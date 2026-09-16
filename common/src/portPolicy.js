/** Shared with the standalone firewall generator, which runs without a TypeScript build. */
export const MANAGER_SLOT_CAP = 100;
export const PORT_SLOT_STRIDE = 10;
export const PROTECTED_PORT_MIN = 10000;
export const PROTECTED_PORT_MAX = 19999;
export const PORT_POLICY_VERSION = 1;
export const OME_PORT_SOURCES = Object.freeze({ OME_SRT_PORT: 'SRS_SRT_PORT', OME_HLS_PORT: 'SRS_HTTP_PORT' });

/** Public roles supported by the bundled and main-v3 layouts. Private endpoints cannot reuse these tuples.
 *
 * Every service named here is one this manager starts, which is what keeps the
 * list to ports a deployment actually binds. Three per-rung peer roles were
 * here and opened 297 ports between them for bee-uploader-480p, -720p and
 * -1080p, services ALL_SERVICES has never carried and the stack's sample
 * config leaves commented out. The slot algebra still reserves their ports,
 * which costs nothing and keeps a later rung deployment's numbering free.
 */
export const PUBLIC_PORT_ROLES = Object.freeze([
  { group: 'bee_p2p', protocol: 'tcp', base: 10006, maxSlot: MANAGER_SLOT_CAP, portVar: 'BEE_UPLOADER_P2P_PORT', service: 'bee-uploader' },
  { group: 'bee_p2p', protocol: 'tcp', base: 10008, maxSlot: MANAGER_SLOT_CAP, portVar: 'BEE_GATEWAY_P2P_PORT', service: 'bee-gateway' },
  { group: 'viewer', protocol: 'tcp', base: 10004, maxSlot: MANAGER_SLOT_CAP, portVar: 'CLIENT_PORT', service: 'client' },
  { group: 'srt_ingest', protocol: 'udp', base: 10001, maxSlot: MANAGER_SLOT_CAP, portVar: 'SRS_SRT_PORT', service: 'srs', aliases: [{ portVar: 'OME_SRT_PORT', service: 'ome' }] },
]);

/** @typedef {{port: number, protocol: string, portVar: string, service: string | null}} ExposureEntry */

/** The public role a saved ruleset can permit at a tuple, independent of its present owner.
 * @param {{port: number, protocol: string}} entry
 */
export function publicPortRole(entry) {
  return PUBLIC_PORT_ROLES.find(role => {
    const slot = (entry.port - role.base) / PORT_SLOT_STRIDE;
    return entry.protocol === role.protocol && Number.isInteger(slot) && slot >= 1 && slot <= role.maxSlot;
  }) ?? null;
}

/** Why admitting an endpoint would escape or contradict the shared firewall policy.
 * @param {ExposureEntry} entry
 * @returns {string | null}
 */
export function portExposureProblem(entry) {
  if (!Number.isInteger(entry.port) || entry.port < PROTECTED_PORT_MIN || entry.port > PROTECTED_PORT_MAX
    || !['tcp', 'udp'].includes(entry.protocol)) {
    return `${entry.portVar} uses ${entry.protocol}/${entry.port}, outside the firewall's protected TCP/UDP range ${PROTECTED_PORT_MIN} to ${PROTECTED_PORT_MAX}.`;
  }
  const role = publicPortRole(entry);
  if (role && ![role, ...(role.aliases ?? [])].some(identity => entry.portVar === identity.portVar && entry.service === identity.service)) {
    return `${entry.protocol}/${entry.port} is a public ${role.group} port. ${entry.portVar} on ${entry.service ?? 'an unknown service'} cannot occupy it.`;
  }
  return null;
}
