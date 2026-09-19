export const FAST_REQUEST_TIMEOUT_MS = 30_000;
export const DEPLOYMENT_WRITE_TIMEOUT_MS = 300_000;

const DEPLOYMENT_WRITES: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST', /^\/profiles\/?$/],
  ['PUT', /^\/profiles\/[^/]+\/?$/],
  ['PUT', /^\/profiles\/[^/]+\/engine-config\/?$/],
  ['POST', /^\/groups\/?$/],
  ['PATCH', /^\/groups\/[^/]+\/config\/?$/],
  ['POST', /^\/groups\/[^/]+\/members\/?$/],
];

export function requestTimeoutMs(method: string, path: string): number {
  const isDeploymentWrite = DEPLOYMENT_WRITES.some(
    ([writeMethod, route]) => method === writeMethod && route.test(path),
  );
  return isDeploymentWrite ? DEPLOYMENT_WRITE_TIMEOUT_MS : FAST_REQUEST_TIMEOUT_MS;
}
