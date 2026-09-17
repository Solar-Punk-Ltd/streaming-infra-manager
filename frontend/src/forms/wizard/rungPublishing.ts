import type { LadderRungState } from '@streaming-infra-manager/common';

const NODE_CHECKS_PASSED = 'Node checks passed.';

/**
 * What the manager's own probe found at the address this rung publishes on.
 *
 * The node checks beside this line are the node's own observations, and say
 * nothing about whether anything answers where a pool sends an uploader. The
 * manager probes that address itself, so a rung it reached and a rung it did
 * not reach are two different answers, and only a state nothing probed leaves
 * publishing unverified.
 */
export function rungPublishingSummary(
  rung: LadderRungState | null,
  asking = false,
): string {
  if (!rung && asking) {
    return `${NODE_CHECKS_PASSED} The manager is asking the publishing address.`;
  }
  switch (rung?.urlState) {
    case 'ok':
      return `${NODE_CHECKS_PASSED} Publishing address answers.`;
    case 'unreachable':
      return `${NODE_CHECKS_PASSED} Publishing address did not answer.`;
    default:
      return `${NODE_CHECKS_PASSED} Publishing is not verified.`;
  }
}

/**
 * The address a probe answered about and what it found, for the line under the
 * summary.
 *
 * The verdict travels with the address because that line shows whether or not a
 * node check blocks above it, and an address printed on its own reads as one
 * that worked.
 */
export function probedRungNote(rung: LadderRungState | null): string | null {
  switch (rung?.urlState) {
    case 'ok':
      return `Publishing address ${rung.url} answers`;
    case 'unreachable':
      return `Publishing address ${rung.url} did not answer`;
    default:
      return null;
  }
}

/** Why this step has no probe answers to show, for the line above the members. */
export function poolProbeFailureNote(error: string | null): string | null {
  return error
    ? `The manager could not be asked about the publishing addresses. ${error}. The node checks below are each node's own answer and are unaffected.`
    : null;
}
