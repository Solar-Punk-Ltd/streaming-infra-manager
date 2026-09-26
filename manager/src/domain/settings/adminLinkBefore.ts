import { ADMIN_API_TOKEN_KEY, ADMIN_API_URL_KEY, type AdminLinkBefore } from '@streaming-infra-manager/common';

/** Where a deployment's two web2 admin keys stand before a save or a create changes them. */
export interface AdminLinkValues {
  /**
   * What the uploader would be given now, secrets in clear: what the next
   * deploy writes, for a deployment that exists, or what the version gives
   * one that does not yet.
   */
  current: Readonly<Record<string, string>>;
  /** What the version sets, which a reset of a stored value puts back. */
  version: Readonly<Record<string, string>>;
  /** The secrets the version requires, which the manager generates at a deploy wherever the version leaves one empty. */
  requiredSecrets: readonly string[];
}

function filled(values: Readonly<Record<string, string>>, key: string): boolean {
  return (values[key] ?? '') !== '';
}

/** The two keys as the rule of `adminLinkEditProblem` reads them. A token the manager generates is there however the version leaves it. */
export function adminLinkBeforeOf({ current, version, requiredSecrets }: AdminLinkValues): AdminLinkBefore {
  const generated = requiredSecrets.includes(ADMIN_API_TOKEN_KEY);
  return {
    url: { current: current[ADMIN_API_URL_KEY] ?? '', afterReset: version[ADMIN_API_URL_KEY] ?? '' },
    token: {
      current: generated || filled(current, ADMIN_API_TOKEN_KEY),
      afterReset: generated || filled(version, ADMIN_API_TOKEN_KEY),
    },
  };
}
