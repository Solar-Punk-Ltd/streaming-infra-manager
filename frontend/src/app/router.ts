import { useCallback, useEffect, useState } from 'react';

/** Where the deployment page should scroll once it has painted. */
export type DeploymentFocus = 'storage' | null;

export type Route =
  | { page: 'overview' }
  | { page: 'deployments' }
  | { page: 'deployment'; name: string; focus: DeploymentFocus }
  | { page: 'group'; id: number }
  | { page: 'host' };

export const routes = {
  overview: '#/',
  deployments: '#/deployments',
  host: '#/host',
  deployment: (name: string): string =>
    `#/deployments/${encodeURIComponent(name)}`,
  deploymentStorage: (name: string): string =>
    `#/deployments/${encodeURIComponent(name)}/storage`,
  group: (id: number): string => `#/groups/${id}`,
};

export function navigate(hash: string): void {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

function parse(hash: string): Route {
  const segments = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  if (segments.length === 0) return { page: 'overview' };
  if (segments[0] === 'host') return { page: 'host' };

  if (segments[0] === 'deployments') {
    if (segments.length === 1) return { page: 'deployments' };
    return {
      page: 'deployment',
      name: segments[1],
      focus: segments[2] === 'storage' ? 'storage' : null,
    };
  }

  if (segments[0] === 'groups' && segments[1]) {
    const id = Number.parseInt(segments[1], 10);
    if (Number.isInteger(id)) return { page: 'group', id };
  }

  return { page: 'overview' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parse(window.location.hash),
  );

  const sync = useCallback(() => {
    setRoute(parse(window.location.hash));
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [sync]);

  return route;
}
