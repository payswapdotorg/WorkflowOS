/**
 * WORK-027 (PR #30 review fix #2): DefaultExecutionCallbackService.
 *
 * Scoped execution callback credentials for the future Companion extension.
 *
 * The ExternalExecutionPackage's returnCallback instructs the extension to
 * POST execution events with an `x-callback-token` header — NEVER the user's
 * general WorkflowOS API key. This service issues + validates those tokens:
 *
 *   - SCOPED to exactly ONE execution (execution_record_id) and to event
 *     ingestion ONLY — only the POST /execution/:id/events route reads
 *     x-callback-token, so the token grants NO other capability (no project
 *     reads, no package reads, no workflow/verification/review mutation, no
 *     arbitrary project.write operations).
 *   - SHORT-LIVED: expires at min(now + callbackTtlMs, the execution's own
 *     handoff-window expiry). Lazy execution expiry applies on validation.
 *   - HASHED AT REST: only the SHA-256 hex of the raw token is persisted.
 *     The raw token is returned exactly once at preparation time (alongside
 *     the one-time handoff token) and is never logged.
 *   - MULTI-USE by design: started → progress → completed are separate
 *     events. Replay/idempotency protection is enforced PER EVENT via the
 *     idempotencyKey dedupe in wfos_execution_events (the handoff token's
 *     strict one-time semantics are intentionally NOT reused here — a
 *     callback token that dies after one event could not report a lifecycle).
 *   - Issued only for EXTERNAL executions in handoff_ready/submitted state.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '@platform/logger.js';
import type { AuditService } from '@modules/audit/index.js';
import type {
  ExecutionCallbackRepository,
  ExecutionCallbackService,
  ExecutionRecordRepository,
  IssuedExecutionCallback,
  ValidatedExecutionCallback,
} from './execution.types.js';
import { ExecutionCallbackError } from './execution.types.js';

export interface DefaultExecutionCallbackServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly callbackRepository: ExecutionCallbackRepository;
  readonly auditService: AuditService;
  readonly logger: Logger;
  /** Callback token TTL in ms (default 60 minutes; capped at execution expiry). */
  readonly callbackTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'] as const;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class DefaultExecutionCallbackService implements ExecutionCallbackService {
  private readonly callbackTtlMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: DefaultExecutionCallbackServiceDeps) {
    this.callbackTtlMs = deps.callbackTtlMs ?? 60 * 60 * 1000;
    this.now = deps.now ?? (() => new Date());
  }

  async issue(executionId: string): Promise<IssuedExecutionCallback> {
    const record = await this.loadAndExpire(executionId);

    if (record.mode !== 'external') {
      throw new ExecutionCallbackError(
        `callback-not-external-execution: execution ${executionId} is mode "${record.mode}" — callback credentials exist only for external executions`,
        'not-external-execution',
      );
    }
    if (record.status !== 'handoff_ready' && record.status !== 'submitted') {
      throw new ExecutionCallbackError(
        `callback-invalid-execution-state: execution ${executionId} is "${record.status}" (expected handoff_ready or submitted)`,
        'invalid-execution-state',
      );
    }

    // Short-lived: never outlive the execution's own handoff window.
    const ttlExpiry = new Date(this.now().getTime() + this.callbackTtlMs);
    const expiresAt =
      record.expiresAt && record.expiresAt.getTime() < ttlExpiry.getTime()
        ? record.expiresAt
        : ttlExpiry;

    const raw = `wfct_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    await this.deps.callbackRepository.create({
      executionRecordId: record.id,
      tokenHash: hashToken(raw),
      expiresAt,
    });

    await this.audit(record.projectId, record.id, executionId, 'EXECUTION_CALLBACK_ISSUED', {
      callbackExpiresAt: expiresAt.toISOString(),
    });

    return { executionId, callbackToken: raw, expiresAt };
  }

  async validate(executionId: string, rawToken: string): Promise<ValidatedExecutionCallback> {
    const record = await this.loadAndExpire(executionId);

    if (record.mode !== 'external') {
      throw new ExecutionCallbackError(
        `callback-not-external-execution: execution ${executionId} is mode "${record.mode}"`,
        'not-external-execution',
      );
    }

    if (
      typeof rawToken !== 'string' ||
      rawToken.length < 20 ||
      !/^wfct_[0-9a-f]+$/.test(rawToken)
    ) {
      throw new ExecutionCallbackError(
        'callback-token-invalid: malformed callback token',
        'callback-token-invalid',
      );
    }

    const callback = await this.deps.callbackRepository.findLatestByHash(hashToken(rawToken));
    // Scope check: the token must belong to EXACTLY this execution.
    if (!callback || callback.executionRecordId !== record.id) {
      throw new ExecutionCallbackError(
        'callback-token-invalid: unknown callback token for this execution',
        'callback-token-invalid',
      );
    }
    if (callback.expiresAt.getTime() <= this.now().getTime()) {
      throw new ExecutionCallbackError(
        'callback-token-expired: callback token TTL elapsed',
        'callback-token-expired',
      );
    }

    return { executionId, executionRecordId: record.id };
  }

  /**
   * Load the execution record, applying LAZY expiry (same policy as the
   * handoff + ingestion services): when the external handoff window has
   * elapsed without completion, flip the record to 'expired' + audit
   * EXECUTION_EXPIRED, then reject.
   */
  private async loadAndExpire(executionId: string) {
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) {
      throw new ExecutionCallbackError(
        `execution-not-found: ${executionId}`,
        'execution-not-found',
      );
    }
    if (
      record.mode === 'external' &&
      record.expiresAt &&
      record.expiresAt.getTime() <= this.now().getTime() &&
      !(TERMINAL as readonly string[]).includes(record.status)
    ) {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'expired',
      });
      await this.audit(record.projectId, record.id, executionId, 'EXECUTION_EXPIRED', {
        previousStatus: record.status,
      });
      throw new ExecutionCallbackError(
        `execution-expired: external handoff window for ${executionId} elapsed at ${record.expiresAt.toISOString()}`,
        'execution-expired',
      );
    }
    return record;
  }

  private async audit(
    projectId: string,
    resourceId: string,
    executionId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.auditService.write({
        projectId,
        eventType,
        actor: 'system',
        source: 'execution-callback-service',
        resourceType: 'execution',
        resourceId,
        executionId,
        metadata,
      });
    } catch (err) {
      this.deps.logger.warn('execution.audit-write-failed', {
        eventType,
        executionId,
        error: (err as Error).message,
      });
    }
  }
}
