import { OME_PORT_SOURCES, type EngineName, type StackContract, type StackPortVar } from '@streaming-infra-manager/common';
import { InvalidStackVersionError } from '../errors/index.js';

type EnginePortContract = Pick<StackContract, 'ports' | 'portAliases'>;

export function omePortTableProblem(contract: EnginePortContract): string | null {
  for (const [name, sourceName] of Object.entries(OME_PORT_SOURCES)) {
    const source = contract.ports.find(port => port.name === sourceName);
    const alias = contract.portAliases?.find(port => port.name === name);
    if (!source || source.service !== 'srs' || !alias || alias.service !== 'ome' || alias.protocol !== source.protocol
      || alias.slotBase !== source.slotBase || alias.defaultPort !== source.defaultPort) {
      return `OME alias ${name} has no compatible Compose port mapping. Rebuild the version to refresh its contract.`;
    }
  }
  return null;
}

/** OME binds the manager's derived SRT/HLS variables. Other ports retain their actual Compose owners. */
export function portTableForEngine(contract: EnginePortContract, engine: EngineName): readonly StackPortVar[] {
  if (engine !== 'ome') return contract.ports;
  const problem = omePortTableProblem(contract);
  if (problem) throw new InvalidStackVersionError(problem);
  const replacements = new Map(Object.entries(OME_PORT_SOURCES).map(([name, source]) =>
    [source, contract.portAliases!.find(port => port.name === name)!]));
  return contract.ports.map(port => replacements.get(port.name) ?? port);
}
