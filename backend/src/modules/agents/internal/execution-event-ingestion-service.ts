/**
 * WORK-027: DefaultExecutionEventIngestionService.
 *
 * Provider-independent external result ingestion boundary
 * (POST /execution/:executionId/events).
 *
 * The future Companion extension reports `started | progress | completed |
 * failed` (optionally with commit/branch/PR/test summary/output) through this
 * boundary. RULES:
 *
 *   - Events update ONLY the execution record (+ events table + audit). This
 *     service never mutates workflow state, never writes verification/
 *     review/PR-association state, and never invokes the workflow engine.
 *     WorkflowOS observes authoritative GitHub/CI/verification/review state
 *     through its existing boundaries. External execution can report a PR —
 *     it can never declare MERGED / VERIFIED / PASS / APPROVED.
 *   - Native executions REJECT events (409 'native-execution-events-not-
 *     allowed'): native run state is owned by the AgentGateway/AgentRun
 *     lifecycle — accepting external events for it would create a second
 *     authority.
 *   - Idempotent: an event with a repeated idempotencyKey is acknowledged as
 *     a duplicate WITHOUT re-applying its effects.
 *   - Reported commit/branch/PR/tests are persisted as BENCHMARK METADATA on
 *     the execution record — they are reported observations, not authority.
 *
 * Execution state machine (execution records ONLY):
 *   started   : handoff_ready | submitted | running → running
 *   progress  : submitted | running (no state change; event recorded)
 *   completed : handoff_ready | submitted | running → completed
 *   failed    : any non-terminal → failed
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type { AuditService } from '@modules/audit/index.js';
import type {
  ExecutionEventIngestionService,
  ExecutionEventRepository,
  ExecutionRecord,
  ExecutionRecordRepository,
  ExecutionState,
  IngestExecutionEventInput,
  IngestedExecutionEvent,
} from './execution.types.js';
import { ExecutionEventError } from './execution.types.js';

export interface DefaultExecutionEventIngestionServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  readonly eventRepository: ExecutionEventRepository;
  readonly auditService: AuditService;
  readonly logger: Logger;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

const STARTED_FROM: readonly ExecutionState[] = ['handoff_ready', 'submitted', 'running'];
const PROGRESS_FROM: readonly ExecutionState[] = ['submitted', 'running'];
const COMPLETED_FROM: readonly ExecutionState[] = ['handoff_ready', 'submitted', 'running'];
const TERMINAL: readonly ExecutionState[] = ['completed', 'failed', 'cancelled', 'expired'];

export class DefaultExecutionEventIngestionService implements ExecutionEventIngestionService {
  private readonly now: () => Date;

  constructor(private readonly deps: DefaultExecutionEventIngestionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async ingest(input: IngestExecutionEventInput): Promise<IngestedExecutionEvent> {
    if (
      input.eventType !== 'started' &&
      input.eventType !== 'progress' &&
      input.eventType !== 'completed' &&
      input.eventType !== 'failed'
    ) {
      throw new ExecutionEventError(
        `invalid-event-type: "${String(input.eventType)}" (expected started|progress|completed|failed)`,
        'invalid-event-type',
      );
    }

    const record = await this.loadAndExpire(input.executionId);

    if (record.mode !== 'external') {
      throw new ExecutionEventError(
        `native-execution-events-not-allowed: execution ${input.executionId} is mode "${record.mode}" — native run state is owned by the AgentGateway`,
        'native-execution-events-not-allowed',
      );
    }

    // Idempotency: a repeated idempotencyKey acknowledges without effects.
    if (input.idempotencyKey) {
      const existing = await this.deps.eventRepository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return {
          accepted: true,
          duplicate: true,
          executionId: input.executionId,
          status: record.status,
        };
      }
    }

    const nextStatus = this.nextStatus(record, input.eventType);
    const receivedAt = this.now();

    const updated = await this.deps.executionRecordRepository.updateStatus(record.id, {
      status: nextStatus,
      externalSessionRef: input.externalSessionRef ?? record.externalSessionRef,
      startedAt: input.eventType === 'started' ? (record.startedAt ?? receivedAt) : undefined,
      completedAt:
        input.eventType === 'completed' || input.eventType === 'failed' ? receivedAt : undefined,
      // Reported observations → benchmark metadata ONLY (never authority).
      benchmarkMetadata:
        input.eventType === 'completed' || input.eventType === 'failed'
          ? {
              reportedCommitRef: input.commitRef ?? null,
              reportedBranch: input.branch ?? null,
              reportedPullRequestRef: input.pullRequestRef ?? null,
              reportedTestSummary: input.testSummary ?? null,
              lastEventType: input.eventType,
            }
          : { lastEventType: input.eventType },
    });

    await this.deps.eventRepository.append({
      executionRecordId: record.id,
      eventType: input.eventType,
      commitRef: input.commitRef ?? null,
      branch: input.branch ?? null,
      pullRequestRef: input.pullRequestRef ?? null,
      testSummary: input.testSummary ?? null,
      output: input.output ?? null,
      externalSessionRef: input.externalSessionRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    if (input.eventType !== 'progress') {
      const eventType =
        input.eventType === 'started'
          ? 'EXECUTION_STARTED'
          : input.eventType === 'completed'
            ? 'EXECUTION_COMPLETED'
            : 'EXECUTION_FAILED';
      await this.audit(record, eventType, {
        status: nextStatus,
        commitRef: input.commitRef ?? null,
        pullRequestRef: input.pullRequestRef ?? null,
      });
    }

    this.deps.logger.info('execution.event-ingested', {
      executionId: input.executionId,
      eventType: input.eventType,
      status: nextStatus,
    });

    return {
      accepted: true,
      duplicate: false,
      executionId: input.executionId,
      status: updated?.status ?? nextStatus,
    };
  }

  private nextStatus(record: ExecutionRecord, eventType: string): ExecutionState {
    if (TERMINAL.includes(record.status)) {
      throw new ExecutionEventError(
        `invalid-execution-state: execution ${record.executionId} is terminal ("${record.status}")`,
        'invalid-execution-state',
      );
    }
    if (eventType === 'started') {
      if (!STARTED_FROM.includes(record.status)) {
        throw new ExecutionEventError(
          `invalid-execution-state: "started" not allowed from "${record.status}"`,
          'invalid-execution-state',
        );
      }
      return 'running';
    }
    if (eventType === 'progress') {
      if (!PROGRESS_FROM.includes(record.status)) {
        throw new ExecutionEventError(
          `invalid-execution-state: "progress" not allowed from "${record.status}"`,
          'invalid-execution-state',
        );
      }
      return record.status;
    }
    if (eventType === 'completed') {
      if (!COMPLETED_FROM.includes(record.status)) {
        throw new ExecutionEventError(
          `invalid-execution-state: "completed" not allowed from "${record.status}"`,
          'invalid-execution-state',
        );
      }
      return 'completed';
    }
    // failed — allowed from any non-terminal state.
    return 'failed';
  }

  private async loadAndExpire(executionId: string) {
    const record = await this.deps.executionRecordRepository.findByExecutionId(executionId);
    if (!record) {
      throw new ExecutionEventError(`execution-not-found: ${executionId}`, 'execution-not-found');
    }
    if (
      record.mode === 'external' &&
      record.expiresAt &&
      record.expiresAt.getTime() <= this.now().getTime() &&
      !TERMINAL.includes(record.status)
    ) {
      await this.deps.executionRecordRepository.updateStatus(record.id, { status: 'expired' });
      await this.audit(record, 'EXECUTION_EXPIRED', { previousStatus: record.status });
      throw new ExecutionEventError(
        `execution-expired: external handoff window for ${executionId} elapsed`,
        'execution-expired',
      );
    }
    return record;
  }

  private async audit(
    record: ExecutionRecord,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.auditService.write({
        projectId: record.projectId,
        eventType,
        actor: 'external-extension',
        source: 'execution-event-ingestion',
        resourceType: 'execution',
        resourceId: record.id,
        executionId: record.executionId,
        workItemId: record.workItemId,
        workOrderId: record.workOrderId,
        metadata,
      });
    } catch (err) {
      this.deps.logger.warn('execution.audit-write-failed', {
        eventType,
        executionId: record.executionId,
        error: (err as Error).message,
      });
    }
  }
}
