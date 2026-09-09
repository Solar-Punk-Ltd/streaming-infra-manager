import type { DeployAttemptView } from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

/** Every attempt still holding a deployment or the host, oldest first. */
export async function fetchAttempts(): Promise<DeployAttemptView[]> {
  const body = await getJson<{ attempts: DeployAttemptView[] }>('/versions/attempts');
  return body.attempts;
}

/** Ends an attempt by hand. The manager refuses a job id that is not this attempt's. */
export async function releaseAttempt(
  id: number,
  jobId: string,
): Promise<DeployAttemptView> {
  const body = await sendJson<{ attempt: DeployAttemptView }>(
    'POST',
    `/versions/attempts/${id}/release`,
    { jobId },
  );
  return body.attempt;
}
