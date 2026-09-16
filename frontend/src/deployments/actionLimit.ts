/**
 * How long the deployments page waits for a deploy, a stop or an uploader
 * start before it stops holding the button.
 *
 * Nothing below the browser bounds these four routes. nginx holds them open
 * for a day on purpose, because a read timeout there is a ceiling on the
 * silence between output lines rather than on the run, and a bee node coming
 * up on a throttled RPC crosses five minutes between lines easily. So a run
 * that wedges leaves the request open, and the page kept the deployment in its
 * busy set for the life of the promise: a disabled spinner with no way back
 * but a page reload.
 *
 * Half an hour is a ceiling on a wedged run and not a target. A first deploy
 * on a fresh host builds images and waits for a node to find its peers, which
 * is minutes, and giving up here does not stop the manager finishing.
 */
export const ACTION_TIMEOUT_MS = 30 * 60_000;

export function actionTimedOutMessage(): string {
  const minutes = Math.round(ACTION_TIMEOUT_MS / 60_000);
  return `The manager has not answered in ${minutes} minutes. It may still be running this, and the deployment's badge shows how it ends.`;
}
