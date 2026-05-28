import { createContext, useContext } from 'react';

const ServerHostContext = createContext<string>('');

export const ServerHostProvider = ServerHostContext.Provider;

export function useServerHost(): string {
  return useContext(ServerHostContext);
}
