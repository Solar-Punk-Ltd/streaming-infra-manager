import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  type AdminLinkTestAnswer,
  type AdminLinkTestOutcome,
  type AdminLinkTestRequest,
  adminLinkTestProblems,
  adminUrlProblem,
  sameAdminOrigin,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import type { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
import { AdminLinkInputError, ProfileNotFoundError } from '../errors/index.js';
import { Logger } from '../Logger.js';
import type { ProfileRepository } from '../ProfileRepository.js';

import { type AdminLinkProbe, type AdminLinkProbeTarget, probeAdminLink } from './adminLinkProbe.js';
import type { ManagerAdminLinkStore } from './ManagerAdminLinkRepository.js';

const logger = Logger.getInstance();

/**
 * The address a deployment's uploader signs its feeds as, where the manager
 * holds it: the stream address of the deployment's own key. A deployment that
 * has none signs with its version's key, whose address the manager does not
 * know, so there is nothing to compare.
 */
function streamAddressOf(profile: Profile): string | null {
  return profile.has_private_key ? (profile.public_key ?? null) : null;
}

/**
 * Test connection, from a page: an address typed there with a typed token or
 * the manager's stored one, and what a deployment's next deploy would give its
 * uploader. The stored token never leaves the manager, and an answer is the
 * outcome code alone. The log line names who asked and the outcome, never the
 * address or a token.
 */
export class AdminLinkTester {
  constructor(
    private readonly store: Pick<ManagerAdminLinkStore, 'storedLink'>,
    private readonly profiles: Pick<ProfileRepository, 'findByName' | 'stackSettingsOf'>,
    private readonly orchestrator: Pick<DeploymentOrchestrator, 'nextEnvFor'>,
    private readonly probe: AdminLinkProbe = probeAdminLink,
  ) {}

  /** Tests an address typed on the Manager settings page or in the new-deployment wizard. */
  async testTyped(request: AdminLinkTestRequest, username: string): Promise<AdminLinkTestAnswer> {
    const problems = adminLinkTestProblems(request);
    if (problems.length > 0) throw new AdminLinkInputError(problems);
    const outcome = request.token.source === 'typed'
      ? await this.probe({ url: request.url, token: request.token.value, feedOwner: request.feedOwner ?? null })
      : await this.outcomeWithStoredToken(request);
    logger.info(`[AdminLink] ${username} tested a web2 admin link typed on a page: ${outcome}`);
    return { outcome };
  }

  /** The stored token goes only to the origin it was saved with, so an address elsewhere is answered without asking it. */
  private async outcomeWithStoredToken(request: AdminLinkTestRequest): Promise<AdminLinkTestOutcome> {
    const stored = await this.store.storedLink();
    if (stored.token === null) return 'no-token';
    if (!sameAdminOrigin(request.url, stored.url ?? '')) return 'stored-token-elsewhere';
    return this.probe({ url: request.url, token: stored.token, feedOwner: request.feedOwner ?? null });
  }

  /**
   * Tests what the deployment's next deploy would give its uploader. A token
   * the deployment stores is presented only to the origin it was stored for,
   * which is what the deploy holds it to as well.
   */
  async testDeployment(name: string, username: string): Promise<AdminLinkTestAnswer> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    const { env } = await this.orchestrator.nextEnvFor(profile);
    const url = env[ADMIN_API_URL_KEY] ?? '';
    const storedWith = (await this.profiles.stackSettingsOf(name))?.adminTokenOrigin ?? null;
    const outcome = storedWith !== null && url !== '' && !sameAdminOrigin(url, storedWith)
      ? 'stored-token-elsewhere'
      : await this.outcomeFor({ url, token: env[ADMIN_API_TOKEN_KEY] ?? '', feedOwner: streamAddressOf(profile) });
    logger.info(`[AdminLink] ${username} tested the web2 admin link of ${name}: ${outcome}`);
    return { outcome };
  }

  /** Answers without asking anything when there is no address to ask, one the uploader could not use, or no token. */
  private async outcomeFor(target: AdminLinkProbeTarget): Promise<AdminLinkTestOutcome> {
    if (target.url === '') return 'not-linked';
    if (adminUrlProblem(target.url) !== null) return 'invalid-address';
    if (target.token === '') return 'no-token';
    return this.probe(target);
  }
}
