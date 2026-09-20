import { ReleaseGuardStore } from './ReleaseGuardStore.js';
import type { ReleaseSlot } from './ReleaseGuardTypes.js';

const RECEIPT_PATH = '/api/internal/release-guard/receipts';
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Sends one already-durable receipt and removes it only after acknowledgement. */
export async function submitPendingReceipt(input: {
  store: ReleaseGuardStore;
  slot: ReleaseSlot;
  adminUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  validateReleaseReceiptDestination(input.adminUrl, input.token);
  const body = await input.store.pendingReceipt(input.slot);
  if (body === null) throw new Error('release receipt outbox is empty');
  const url = receiptUrl(input.adminUrl, input.slot);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('release receipt timeout is invalid');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(url, {
        method: 'PUT',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${input.token}`,
          'content-type': 'application/json',
        },
        body,
      });
    } catch {
      throw new Error('release receipt submission failed');
    }
    await consumeBounded(response);
    if (!response.ok) throw new Error(`release receipt endpoint refused with status ${response.status}`);
    await input.store.acknowledge(body);
  } finally {
    clearTimeout(timeout);
  }
}

/** Validates the fixed authenticated receipt boundary before a transition may start. */
export function validateReleaseReceiptDestination(adminUrl: string, token: string): void {
  adminBaseUrl(adminUrl);
  if (token.length < 32) throw new Error('release receipt bearer is not configured');
}

function adminBaseUrl(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('release receipt admin URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('release receipt admin URL is invalid');
  }
  return url;
}

function receiptUrl(base: string, slot: ReleaseSlot): string {
  const url = adminBaseUrl(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${RECEIPT_PATH}/${encodeURIComponent(slot.role)}/${encodeURIComponent(slot.id)}`;
  return url.toString();
}

async function consumeBounded(response: Response): Promise<void> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('release receipt response is oversized');
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) return;
    bytes += part.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('release receipt response is oversized');
    }
  }
}
