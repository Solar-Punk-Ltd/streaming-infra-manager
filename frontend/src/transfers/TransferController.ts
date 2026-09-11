import type { ChequebookAdmissionDetail, ChequebookOperationDetail, TransferDirection } from '@streaming-infra-manager/common';
import { isExactTransfer, type StoredTransferIntent, type TransferIntentStore } from './transferIntentStore';
import { isCompleteTransferDetail, permitsNewTransfer } from './transferEvidence';
import { TransferApiError } from './TransferApiError';

export interface TransferProfileIdentity { readonly name: string; readonly instanceId: string }
export interface TransferDraft { readonly direction: TransferDirection; readonly amountPlur: string }
export interface TransferControllerApi {
  /** Every call must issue a fresh exact request with cache:no-store. */
  lookup(requestId: string, signal: AbortSignal): Promise<ChequebookOperationDetail | null>;
  profile(name: string, signal: AbortSignal): Promise<TransferProfileIdentity | null>;
  submit(intent: StoredTransferIntent, signal: AbortSignal): Promise<ChequebookAdmissionDetail>;
}
export type TransferControllerIssue = 'lookup_missing' | 'lookup_unavailable' | 'incomplete_response' | 'response_unknown' |
  'target_changed' | 'target_unavailable' | 'account_changed' | 'storage_unavailable' | 'identity_conflict' | 'terminal_required' | 'busy' | 'link_unavailable';
export interface TransferControllerState {
  readonly phase: 'idle' | 'signed_out' | 'entry' | 'loading' | 'sending' | 'ready';
  readonly intent: StoredTransferIntent | null;
  readonly detail: ChequebookOperationDetail | null;
  readonly blocking: ChequebookOperationDetail | null;
  readonly blockingReason: 'busy' | 'identity_conflict' | null;
  readonly issue: TransferControllerIssue | null;
}
type Context = { readonly accountId: number; readonly profile: TransferProfileIdentity };
type ActiveTask = { readonly controller: AbortController; readonly epoch: number; readonly context: Context };
const empty = (phase: TransferControllerState['phase']): TransferControllerState => ({ phase, intent: null, detail: null, blocking: null, blockingReason: null, issue: null });

/**
 * A saved UUID survives every interrupted UI action. Only explicit confirmation or retry can call submit.
 *
 * A re-read of the same request keeps the record already on screen until the
 * manager answers, because the page re-reads unattended every few seconds and
 * an empty panel between the request and its answer reads as a lost outcome.
 */
export class TransferController {
  private snapshot: TransferControllerState = empty('idle');
  private context: Context | null = null;
  private epoch = 0;
  private active: ActiveTask | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: TransferIntentStore, private readonly api: TransferControllerApi,
    private readonly requestId: () => string = () => crypto.randomUUID()) {}

  get state(): TransferControllerState { return this.snapshot; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  setContext(accountId: number | null, profile: TransferProfileIdentity | null): void {
    const next = Number.isSafeInteger(accountId) && accountId! > 0 && profile ? { accountId: accountId!, profile: Object.freeze({ ...profile }) } : null;
    if (next?.accountId === this.context?.accountId && next?.profile.name === this.context?.profile.name && next?.profile.instanceId === this.context?.profile.instanceId) return;
    this.cancel();
    this.context = next;
    this.update(empty(next ? 'idle' : 'signed_out'));
  }

  cancel(): void {
    this.epoch++;
    this.active?.controller.abort();
    this.active = null;
    this.update(empty(this.context ? 'idle' : 'signed_out'));
  }

  async restore(): Promise<void> {
    await this.run(async task => {
      const intent = await this.current(task);
      if (!this.live(task) || !intent) return;
      await this.lookup(task, intent);
    });
  }

  async confirmNew(draft: TransferDraft, expectedCurrentRequestId: string | null): Promise<void> {
    await this.run(async task => {
      const current = await this.current(task);
      if (!this.live(task)) return;
      if ((current?.requestId ?? null) !== expectedCurrentRequestId) {
        if (current) await this.lookup(task, current);
        return;
      }
      if (current) {
        const detail = await this.lookup(task, current);
        if (!this.live(task) || !detail) return;
        if (!permitsNewTransfer(detail)) { this.patch({ phase: 'ready', issue: 'terminal_required' }); return; }
      }
      const input = { requestId: this.requestId(), accountId: task.context.accountId, profileName: task.context.profile.name,
        profileInstanceId: task.context.profile.instanceId, direction: draft.direction, amountPlur: draft.amountPlur, createdAt: new Date().toISOString() };
      let saved;
      try { saved = await this.store.confirm(input, expectedCurrentRequestId); }
      catch { if (this.live(task)) this.patch({ phase: 'ready', issue: 'storage_unavailable' }); return; }
      if (!this.live(task)) return;
      this.update({ ...empty('ready'), intent: saved.intent });
      if (saved.kind === 'existing') { await this.lookup(task, saved.intent); return; }
      await this.send(task, saved.intent);
    });
  }

  async retryExact(): Promise<void> {
    await this.run(async task => {
      const intent = await this.current(task);
      if (!this.live(task) || !intent) return;
      const detail = await this.lookup(task, intent);
      if (!this.live(task) || detail || this.snapshot.issue !== 'lookup_missing' || this.snapshot.blockingReason === 'identity_conflict') return;
      await this.send(task, intent);
    });
  }

  private async current(task: ActiveTask): Promise<StoredTransferIntent | null> {
    try {
      const intent = await this.store.current(task.context.accountId, task.context.profile.instanceId);
      if (this.live(task)) {
        const retained = intent && intent.requestId === this.snapshot.intent?.requestId
          ? { detail: this.snapshot.detail, blocking: this.snapshot.blocking, blockingReason: this.snapshot.blockingReason } : {};
        this.update({ ...empty(intent ? 'loading' : 'entry'), intent, ...retained });
      }
      return intent;
    } catch {
      if (this.live(task)) this.patch({ phase: 'ready', issue: 'storage_unavailable' });
      throw new Error('Transfer storage is unavailable');
    }
  }

  private async lookup(task: ActiveTask, intent: StoredTransferIntent): Promise<ChequebookOperationDetail | null> {
    let detail;
    try { detail = await this.api.lookup(intent.requestId, task.controller.signal); }
    catch (error) { this.failedRequest(task, error, 'lookup_unavailable'); return null; }
    if (!this.live(task)) return null;
    if (!detail) { this.patch({ phase: 'ready', detail: null, issue: 'lookup_missing' }); return null; }
    if (!isCompleteTransferDetail(detail)) { this.patch({ phase: 'ready', detail: null, issue: 'incomplete_response' }); return null; }
    if (!isExactTransfer(intent, detail.operation)) { await this.blocked(task, intent, detail, 'identity_conflict'); return null; }
    return await this.exact(task, intent, detail) ? detail : null;
  }

  private async send(task: ActiveTask, intent: StoredTransferIntent): Promise<void> {
    if (!this.live(task)) return;
    let profile;
    try { profile = await this.api.profile(intent.profileName, task.controller.signal); }
    catch (error) { this.failedRequest(task, error, 'target_unavailable'); return; }
    if (!this.live(task)) return;
    if (!profile || profile.name !== intent.profileName || profile.instanceId !== intent.profileInstanceId || task.context.accountId !== intent.accountId) {
      this.patch({ phase: 'ready', issue: 'target_changed' }); return;
    }
    this.patch({ phase: 'sending', issue: null });
    let result;
    try { result = await this.api.submit(intent, task.controller.signal); }
    catch (error) { this.failedRequest(task, error, 'response_unknown'); return; }
    if (!this.live(task)) return;
    if (!isCompleteTransferDetail(result) || !['admitted', 'replayed', 'busy', 'conflict'].includes(result.kind)) {
      this.patch({ phase: 'ready', issue: 'response_unknown' }); return;
    }
    if (result.kind === 'busy' || result.kind === 'conflict' || !isExactTransfer(intent, result.operation)) {
      await this.blocked(task, intent, result, result.kind === 'busy' ? 'busy' : 'identity_conflict');
    } else await this.exact(task, intent, result);
  }

  private async exact(task: ActiveTask, intent: StoredTransferIntent, detail: ChequebookOperationDetail): Promise<boolean> {
    if (!this.live(task)) return false;
    let issue: 'link_unavailable' | null = null;
    try {
      const saved = await this.store.recordExact(intent.requestId, detail.operation);
      if (!this.live(task)) return false;
      if (saved.kind === 'conflict') { await this.blocked(task, intent, detail, 'identity_conflict'); return false; }
      if (saved.kind === 'unavailable') issue = 'link_unavailable';
    } catch { issue = 'link_unavailable'; }
    if (!this.live(task)) return false;
    this.update({ phase: 'ready', intent, detail, blocking: null, blockingReason: null, issue });
    return true;
  }

  private async blocked(task: ActiveTask, intent: StoredTransferIntent, detail: ChequebookOperationDetail, issue: 'busy' | 'identity_conflict'): Promise<void> {
    if (!this.live(task)) return;
    this.update({ phase: 'ready', intent, detail: null, blocking: detail, blockingReason: issue, issue });
    try { await this.store.recordBlocking(intent.requestId, detail.operation.id); }
    catch { /* The immutable request UUID still provides exact recovery. */ }
  }

  private failedRequest(task: ActiveTask, error: unknown, issue: TransferControllerIssue): void {
    if (!this.live(task)) return;
    if (error instanceof Error && error.name === 'SessionEndedError') { this.setContext(null, null); return; }
    if (error instanceof TransferApiError && (error.reason === 'account_changed' || error.reason === 'target_changed')) {
      this.patch({ phase: 'ready', issue: error.reason }); return;
    }
    this.patch({ phase: 'ready', issue });
  }

  private async run(action: (task: ActiveTask) => Promise<void>): Promise<void> {
    if (this.active || !this.context) return;
    const task = { controller: new AbortController(), epoch: this.epoch, context: this.context };
    this.active = task;
    this.patch({ phase: 'loading', issue: null });
    try { await action(task); }
    catch { if (this.live(task) && this.snapshot.issue === null) this.patch({ phase: 'ready', issue: 'storage_unavailable' }); }
    finally { if (this.active === task) this.active = null; }
  }

  private live(task: ActiveTask): boolean { return this.active === task && this.epoch === task.epoch && !task.controller.signal.aborted; }
  private patch(patch: Partial<TransferControllerState>): void { this.update({ ...this.snapshot, ...patch }); }
  private update(state: TransferControllerState): void { this.snapshot = Object.freeze(state); for (const listener of this.listeners) listener(); }
}
