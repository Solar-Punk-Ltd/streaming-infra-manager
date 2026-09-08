import type { BeeNodeObservation } from '@streaming-infra-manager/common';

const MAX_PROBE_BYTES = 64 * 1024;
const MAX_PROBE_TIMEOUT_MS = 3_000;

type ProbeResult = { kind: 'response'; status: number; body: Record<string, unknown> | null } | { kind: 'unreachable' };

async function readProbe(baseUrl: string, path: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1), MAX_PROBE_TIMEOUT_MS));
  let responded = false;
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal, redirect: 'error' });
    responded = true;
    if (!response.body) return { kind: 'response', status: response.status, body: null };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_PROBE_BYTES) return { kind: 'response', status: response.status, body: null };
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { kind: 'response', status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null };
  } catch {
    return responded ? { kind: 'response', status: 0, body: null } : { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function version(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(value) ? value : null;
}

function chainProgress(result: ProbeResult): BeeNodeObservation['chainProgress'] {
  if (result.kind !== 'response' || result.status !== 200 || !result.body) return null;
  const { block, chainTip } = result.body;
  return typeof block === 'number' && typeof chainTip === 'number'
    && Number.isSafeInteger(block) && Number.isSafeInteger(chainTip)
    && block >= 0 && chainTip >= block ? { block, chainTip } : null;
}

export async function observeBeeNode(baseUrl: string, timeoutMs: number): Promise<BeeNodeObservation> {
  const [health, readiness, chain] = await Promise.all([
    readProbe(baseUrl, '/health', timeoutMs),
    readProbe(baseUrl, '/readiness', timeoutMs),
    readProbe(baseUrl, '/chainstate', timeoutMs),
  ]);
  const healthBody = health.kind === 'response' && health.status === 200 ? health.body : null;
  const healthStatus = healthBody?.status === 'ok' || healthBody?.status === 'nok' ? healthBody.status : null;
  const readinessStatus = readiness.kind !== 'response' ? null
    : readiness.status === 200 && readiness.body?.status === 'ready' ? 'ready'
    : readiness.status === 400 && readiness.body?.status === 'notReady' ? 'notReady' : null;
  const state = healthStatus === 'nok' ? 'unhealthy'
    : healthStatus === 'ok' && readinessStatus === 'ready' ? 'ready'
    : healthStatus === 'ok' && readinessStatus === 'notReady' ? 'initializing'
    : health.kind === 'unreachable' && readiness.kind === 'unreachable' ? 'unreachable' : 'unknown';
  return {
    state, observedAt: new Date().toISOString(), healthStatus, readinessStatus,
    version: version(healthBody?.version), apiVersion: version(healthBody?.apiVersion),
    chainProgress: chainProgress(chain),
  };
}
