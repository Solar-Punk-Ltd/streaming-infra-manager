import { OME_PORT_SOURCES, type EngineName, type StackContract, type StackPortVar } from '@streaming-infra-manager/common';
import { InvalidStackVersionError } from '../errors/index.js';

/** OME binds the manager's derived SRT/HLS variables. Other ports retain their actual Compose owners. */
export function portTableForEngine(contract: Pick<StackContract, 'ports' | 'portAliases'>, engine: EngineName): readonly StackPortVar[] {
  if (engine !== 'ome') return contract.ports;
  const replacements = new Map<string, StackPortVar>();
  for (const [name, sourceName] of Object.entries(OME_PORT_SOURCES)) {
    const source = contract.ports.find(port => port.name === sourceName);
    const alias = contract.portAliases?.find(port => port.name === name);
    if (!source || !alias || alias.service !== 'ome' || alias.protocol !== source.protocol
      || alias.slotBase !== source.slotBase || alias.defaultPort !== source.defaultPort) {
      throw new InvalidStackVersionError(`OME alias ${name} has no compatible Compose port mapping. Rebuild the version to refresh its contract.`);
    }
    replacements.set(sourceName, alias);
  }
  return contract.ports.map(port => replacements.get(port.name) ?? port);
}
