/**
 * WorkflowOS Companion — ExecutionReporter.
 *
 * Reports execution events to WorkflowOS with:
 *
 *   - IDEMPOTENCY (§16): every event carries a stable idempotencyKey derived
 *     from executionId + event sequence. Retries REUSE the key, so network
 *     failure → retry → duplicate delivery collapse server-side (the backend
 *     dedupes by key) and never create duplicate execution state.
 *   - OFFLINE BUFFERING (§17): safe, non-secret events buffer IN MEMORY (and
 *     chrome.storage.session so a service-worker restart within the same
 *     browser session keeps the queue). Callback tokens are NEVER written to
 *     localStorage or disk-backed storage.local (statically enforced).
 *   - BOUNDED BACKOFF: 1s → 2s → 4s → 8s (capped), reset on success.
 *   - SESSION EXPIRY: once the callback credential expires, retries stop,
 *     the queue is dropped, and the session is marked expired.
 *   - TOKEN HYGIENE: tokens are never logged and never serialized into
 *     queue entries that cross a boundary.
 */
import type { ExecutionEventRequest, WorkflowOsClient, WorkflowOsError } from './client.js';

/** Minimal session shape the reporter needs (keeps tests light). */
export interface ReporterSession {
  readonly executionId: string;
  readonly callback: { readonly token: string; readonly expiresAt: string; readonly origin: string };
}

export interface QueuedEvent {
  readonly event: ExecutionEventRequest;
  /** Delivery attempts so far. */
  attempts: number;
}

export interface ReporterStorage {
  /** Memory-backed session storage (chrome.storage.session or a test fake). */
  loadQueue(): Promise<QueuedEvent[]>;
  saveQueue(queue: QueuedEvent[]): Promise<void>;
}

export type ReporterListener = (state: {
  pending: number;
  online: boolean;
  lastError: string | null;
  lastStatus: string | null;
}) => void;

const MAX_ATTEMPTS_BEFORE_SLOW = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;

export class ExecutionReporter {
  private queue: QueuedEvent[] = [];
  private seq = 0;
  private inflight: Promise<void> | null = null;
  private online = true;
  private lastError: string | null = null;
  private lastStatus: string | null = null;
  private readonly listeners = new Set<ReporterListener>();
  /** Injectable clock + sleeper for deterministic tests. */
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: Pick<WorkflowOsClient, 'sendExecutionEvent'>,
    private readonly storage: ReporterStorage,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  onStateChange(listener: ReporterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isOnline(): boolean {
    return this.online;
  }

  get lastKnownStatus(): string | null {
    return this.lastStatus;
  }

  /** Restore the queue after a service-worker restart (same browser session). */
  async restore(): Promise<void> {
    this.queue = await this.storage.loadQueue();
    const maxSeq = this.queue.reduce(
      (acc, e) => Math.max(acc, this.seqFromKey(e.event.idempotencyKey)),
      0,
    );
    this.seq = maxSeq + 1;
    this.emit();
  }

  /** Enqueue an event (stable idempotencyKey) and deliver it. */
  async report(
    session: ReporterSession,
    event: Omit<ExecutionEventRequest, 'idempotencyKey'>,
  ): Promise<void> {
    const idempotencyKey = `${session.executionId}:${this.seq}`;
    this.seq += 1;
    this.queue.push({ event: { ...event, idempotencyKey }, attempts: 0 });
    await this.storage.saveQueue(this.queue);
    this.emit();
    // Fire-and-forget delivery: callers may await flush() explicitly. The
    // drain owns retry/backoff; report() never blocks observation handling.
    void this.kick(session);
  }

  /**
   * Deliver the queue. Retries with bounded backoff until the session's
   * callback credential expires — then drops the queue (caller marks the
   * session expired). Concurrent flush() calls chain onto the in-flight
   * drain (and run another pass if new events arrived meanwhile).
   */
  async flush(session: ReporterSession): Promise<void> {
    while (this.queue.length > 0) {
      await this.kick(session);
    }
  }

  /** Start (or join) the in-flight drain pass. */
  kick(session: ReporterSession): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.drain(session).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** One drain pass: deliver until the queue empties or a permanent stop. */
  private async drain(session: ReporterSession): Promise<void> {
    while (this.queue.length > 0) {
      if (this.credentialExpired(session)) {
        // §17: session expired → stop retrying, drop buffered events.
        this.queue = [];
        await this.storage.saveQueue(this.queue);
        this.lastError = 'callback credential expired';
        this.emit();
        return;
      }
      const entry = this.queue[0]!;
      try {
        const result = await this.client.sendExecutionEvent(session, entry.event);
        this.lastStatus = result.status;
        this.lastError = null;
        this.online = true;
        this.queue.shift();
        await this.storage.saveQueue(this.queue);
        this.emit();
      } catch (err) {
        const werr = err as WorkflowOsError;
        this.online = werr.status === 0;
        this.lastError = werr.message;
        if (werr.status === 410 || werr.status === 409) {
          // Expired credential / replayed-forever state: drop the event so
          // the queue cannot wedge, and stop (permanent rejections).
          this.queue.shift();
          await this.storage.saveQueue(this.queue);
          this.emit();
          return;
        }
        if (werr.status === 403) {
          // Invalid credential — permanent; stop entirely.
          this.queue = [];
          await this.storage.saveQueue(this.queue);
          this.emit();
          return;
        }
        // Transient (network / 5xx): bounded backoff and retry.
        entry.attempts += 1;
        this.emit();
        const backoff = Math.min(
          BASE_BACKOFF_MS * 2 ** Math.min(entry.attempts, MAX_ATTEMPTS_BEFORE_SLOW),
          MAX_BACKOFF_MS,
        );
        await this.sleep(backoff);
      }
    }
    this.emit();
  }

  /** Stop everything (session stopped by the user). */
  stop(): void {
    this.queue = [];
    this.lastError = null;
    this.emit();
  }

  private credentialExpired(session: ReporterSession): boolean {
    const expiresAtMs = Date.parse(session.callback.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= this.now();
  }

  private seqFromKey(key: string): number {
    const idx = key.lastIndexOf(':');
    const n = idx >= 0 ? Number.parseInt(key.slice(idx + 1), 10) : Number.NaN;
    return Number.isFinite(n) ? n : 0;
  }

  private emit(): void {
    const snapshot = {
      pending: this.queue.length,
      online: this.online,
      lastError: this.lastError,
      lastStatus: this.lastStatus,
    };
    for (const listener of this.listeners) listener(snapshot);
  }
}
