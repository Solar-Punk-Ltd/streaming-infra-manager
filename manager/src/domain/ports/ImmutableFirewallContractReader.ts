import { basename, dirname } from 'node:path';
import { InvalidStackVersionError } from '../errors/index.js';
import { readBuildManifest } from '../versions/buildManifest.js';
import { buildDirFor } from '../versions/stackPaths.js';
import { readStackContract } from '../versions/stackContract.js';
import type { FirewallContract, FirewallContractReader, FirewallVersion } from './firewallInventoryTypes.js';

/** Reads only a finished immutable build. Never invokes a build or deployment script. */
export class ImmutableFirewallContractReader implements FirewallContractReader {
  async read(version: FirewallVersion, buildId: string): Promise<FirewallContract> {
    if (version.layout !== 'builds' || !version.rootPath) {
      throw new InvalidStackVersionError('Firewall inventory requires immutable build history.');
    }
    const root = buildDirFor(dirname(version.rootPath), basename(version.rootPath), buildId);
    const read = readBuildManifest(root);
    if (read.problem || read.manifest?.buildId !== buildId) {
      throw new InvalidStackVersionError(`Firewall inventory: ${read.problem ?? 'The build manifest names a different build.'}`);
    }
    const { ports, portAliases, maxSlot, allocationProblem } = readStackContract(root);
    return { ports, portAliases, maxSlot, allocationProblem };
  }
}
