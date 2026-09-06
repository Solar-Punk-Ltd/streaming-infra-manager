/**
 * How long any one call to the daemon may take.
 *
 * Handed to dockerode as its socket timeout and applied again around each call,
 * because the two cover different failures: the socket timeout ends a request
 * that gets no bytes back, and the bound here ends one that is answered slowly
 * enough to hold its caller open regardless.
 */
export const DOCKER_TIMEOUT_MS = 15_000;

/**
 * Rejects once `call` has gone `timeoutMs` without settling.
 *
 * `timedOut` builds the rejection, so a caller that answers HTTP can throw the
 * error its handler maps, and one that only logs can keep the plain message.
 */
export async function answeredInTime<T>(
  call: Promise<T>,
  timeoutMs: number = DOCKER_TIMEOUT_MS,
  timedOut: () => Error = () =>
    new Error(`docker did not answer within ${timeoutMs}ms`),
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timedOut()), timeoutMs);
  });

  try {
    return await Promise.race([call, bound]);
  } finally {
    clearTimeout(timer);
  }
}
