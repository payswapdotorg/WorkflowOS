/**
 * WORK-027: DefaultExecutionHandoffService.
 *
 * Secure retrieval boundary for ExternalExecutionPackages:
 *
 *   - Packages are PROJECT-SCOPED and WORK-ITEM-SCOPED: the record carries
 *     project/work-item ids, and the route layer additionally requires the
 *     CALLER to be authorized for that project (requireProjectAuthorization).
 *     A stolen token alone is never sufficient.
 *   - SHORT-LIVED: every handoff token has a TTL (default 15 minutes).
 *   - ONE-TIME / REPLAY-PROTECTED: redeeming a token consumes it; a replayed
 *     token is rejected with 'handoff-token-already-used'.
 *   - ONLY the SHA-256 hash of the raw token is persisted. The raw token is
 *     returned to the authorized caller exactly once and never logged.
 *   - Malformed or unknown tokens are rejected ('handoff-token-invalid').
 *   - Lazy expiry: when an external execution's handoff window has elapsed
 *     without completion, the record flips to 'expired' (audited as
 *     EXECUTION_EXPIRED) the next time it is touched.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '@platform/logger.js';
import type { AuditService } from '@modules/audit/index.js';
import type {
  ExecutionHandoffRepository,
  ExecutionHandoffService,
  ExecutionRecordRepository,
  IssuedExecutionHandoff,
  RedeemedExecutionPackage,
} from './execution.types.js';
import { ExecutionHandoffError } from './execution.types.js';

export interface DefaultExecutionHandoffServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly handoffRepository: ExecutionHandoffRepository;
  readonly auditService: AuditService;
  readonly logger: Logger;
  /** Handoff token TTL in ms (default 15 minutes). */
  readonly handoffTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class DefaultExecutionHandoffService implements ExecutionHandoffService {
  private readonly handoffTtlMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: DefaultExecutionHandoffServiceDeps) {
    this.handoffTtlMs = deps.handoffTtlMs ?? 15 * 60 * 1000;
    this.now = deps.now ?? (() => new Date());
  }

  async issue(executionId: string): Promise<IssuedExecutionHandoff> {
    const record = await this.loadAndExpire(executionId);

    if (record.mode !== 'external') {
      throw new ExecutionHandoffError(
        `handoff-not-external-execution: execution ${executionId} is mode "${record.mode}" — handoffs exist only for external executions`,
        'not-external-execution',
      );
    }
    if (record.status !== 'handoff_ready' && record.status !== 'submitted') {
      throw new ExecutionHandoffError(
        `handoff-invalid-execution-state: execution ${executionId} is "${record.status}" (expected handoff_ready or submitted)`,
        'invalid-execution-state',
      );
    }

    const raw = `wfht_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(this.now().getTime() + this.handoffTtlMs);
    await this.deps.handoffRepository.create({
      executionRecordId: record.id,
      tokenHash: hashToken(raw),
      expiresAt,
    });

    await this.audit(record.projectId, record.id, executionId, 'EXECUTION_HANDOFF_ISSUED', {
      handoffExpiresAt: expiresAt.toISOString(),
    });

    return { executionId, handoffToken: raw, expiresAt };
  }

  async redeem(executionId: string, rawToken: string): Promise<RedeemedExecutionPackage> {
    const record = await this.loadAndExpire(executionId);

    if (record.mode !== 'external') {
      throw new ExecutionHandoffError(
        `handoff-not-external-execution: execution ${executionId} is mode "${record.mode}"`,
        'not-external-execution',
      );
    }
    if (record.status !== 'handoff_ready' && record.status !== 'submitted') {
      throw new ExecutionHandoffError(
        `handoff-invalid-execution-state: execution ${executionId} is "${record.status}"`,
        'invalid-execution-state',
      );
    }

    if (typeof rawToken !== 'string' || rawToken.length < 20 || !/^wfht_[0-9a-f]+$/.test(rawToken)) {
      throw new ExecutionHandoffError(
        'handoff-token-invalid: malformed handoff token',
        'handoff-token-invalid',
      );
    }

    const handoff = await this.deps.handoffRepository.findLatestByHash(hashToken(rawToken));
    if (!handoff || handoff.executionRecordId !== record.id) {
      throw new ExecutionHandoffError(
        'handoff-token-invalid: unknown handoff token for this execution',
        'handoff-token-invalid',
      );
    }
    if (handoff.consumedAt) {
      throw new ExecutionHandoffError(
        'handoff-token-already-used: one-time handoff token was already redeemed (replay rejected)',
        'handoff-token-already-used',
      );
    }
    if (handoff.expiresAt.getTime() <= this.now().getTime()) {
      throw new ExecutionHandoffError(
        'handoff-token-expired: handoff token TTL elapsed',
        'handoff-token-expired',
      );
    }

    // One-time: consume FIRST so a concurrent replay cannot win.
    const consumed = await this.deps.handoffRepository.consume(handoff.id, this.now());
    if (!consumed) {
      throw new ExecutionHandoffError(
        'handoff-token-already-used: one-time handoff token was already redeemed (replay rejected)',
        'handoff-token-already-used',
      );
    }

    if (!record.packageValue) {
      throw new ExecutionHandoffError(
        `handoff-package-missing: execution ${executionId} has no stored package`,
        'invalid-execution-state',
      );
    }

    // Package handed to the external session → execution advances to
    // 'submitted' (an EXECUTION-record state, never a workflow state).
    const updated = await this.deps.executionRecordRepository.updateStatus(record.id, {
      status: record.status === 'handoff_ready' ? 'submitted' : record.status,
    });

    await this.audit(record.projectId, record.id, executionId, 'EXECUTION_PACKAGE_REDEEMED', {
      status: updated?.status ?? 'submitted',
    });

    return {
      executionId,
      status: updated?.status ?? 'submitted',
      package: record.packageValue,
    };
  }

  /**
   * Load the execution record, applying LAZY expiry: when the external
   * handoff window has elapsed and the execution never completed, flip the
   * record to 'expired' + audit EXECUTION_EXPIRED, then reject.
   */
  private async loadAndExpire(executionId: string) {
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) {
      throw new ExecutionHandoffError(
        `execution-not-found: ${executionId}`,
        'execution-not-found',
      );
    }
    if (
      record.mode === 'external' &&
      record.expiresAt &&
      record.expiresAt.getTime() <= this.now().getTime() &&
      !['completed', 'failed', 'cancelled', 'expired'].includes(record.status)
    ) {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'expired',
      });
      await this.audit(record.projectId, record.id, executionId, 'EXECUTION_EXPIRED', {
        previousStatus: record.status,
      });
      throw new ExecutionHandoffError(
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
        source: 'execution-handoff-service',
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
