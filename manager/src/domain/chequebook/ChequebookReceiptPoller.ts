import { RECEIPT_POLL_INTERVAL_MS } from '@streaming-infra-manager/common';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';

type DueRows = Pick<ChequebookOperationRepository, 'listAwaitingReceipt'>;
type CheckReceipt = Pick<ChequebookReceiptCheck, 'check'>;
type CancelTick = () => void;

export interface ReceiptPollerOptions {
  readonly intervalMs?: number;
  readonly batchLimit?: number;
  readonly log?: (line: string) => void;
  readonly schedule?: (call: () => void, milliseconds: number) => CancelTick;
}

const DEFAULT_BATCH_LIMIT = 20;
const defaultSchedule = (call: () => void, milliseconds: number): CancelTick => {
  const timer = setTimeout(call, milliseconds);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Asks the chain about the transfers the manager is still waiting on.
 *
 * The budget belongs to the row, not to this object: a restart resumes the
 * rows whose budget has not passed and adopts no others, because the query
 * that lists them is the only thing that decides what is due.
 */
export class ChequebookReceiptPoller {
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly log: (line: string) => void;
  private readonly schedule: (call: () => void, milliseconds: number) => CancelTick;
  private cancelTick: CancelTick | null = null;
  private batch: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly repository: DueRows, private readonly receipts: CheckReceipt, options: ReceiptPollerOptions = {}) {
    this.intervalMs = options.intervalMs ?? RECEIPT_POLL_INTERVAL_MS;
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.log = options.log ?? (() => {});
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Runs the first batch at once. A stopped poller stays stopped. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.runBatch();
  }

  /** Resolves once no tick is scheduled and no batch is running. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTick?.();
    this.cancelTick = null;
    await this.batch;
  }

  private runBatch(): void {
    const batch = this.tick().catch(() => {}).then(() => {
      if (this.batch !== batch) return;
      this.batch = null;
      if (!this.stopped) this.cancelTick = this.schedule(() => { this.cancelTick = null; this.runBatch(); }, this.intervalMs);
    });
    this.batch = batch;
  }

  private async tick(): Promise<void> {
    let due;
    try { due = await this.repository.listAwaitingReceipt({ intervalMs: this.intervalMs, limit: this.batchLimit }); }
    catch { this.log('Receipt polling could not read the transfer journal.'); return; }
    const notes: string[] = [];
    for (const operation of due) {
      try {
        const checked = await this.receipts.check(operation.id);
        if (checked.state !== 'submitted') notes.push(`${operation.id} ${checked.receiptObservation?.kind ?? checked.state}`);
      } catch { notes.push(`${operation.id} journal_error`); }
    }
    if (notes.length > 0) this.log(`Receipt polling checked ${due.length}: ${notes.join(', ')}`);
  }
}
