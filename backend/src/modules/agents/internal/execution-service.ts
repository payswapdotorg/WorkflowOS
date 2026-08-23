/**
 * WORK-027: DefaultExecutionService.
 *
 * The single entry point for submitting an ExecutionTask through the provider
 * boundary. Flow:
 *
 *   1. Create the execution record (status 'created') with the deterministic
 *      prompt + digest and the initial benchmark metadata.
 *   2. Emit EXECUTION_CREATED audit event.
 *   3. Dispatch to the ExecutionProvider matching the task's mode:
 *        native   → NativeExecutionProvider → AgentGateway (unchanged)
 *        external → ExternalExecutionProvider → deterministic package
 *   4. Persist the outcome on the execution record:
 *        native success   → status 'completed' + agentRunId (+timestamps)
 *        external         → status 'handoff_ready' + package + expiresAt
 *        provider failure → status 'failed' (native) — the error propagates
 *                           so the route returns a failure response.
 *   5. Emit the outcome audit event (EXECUTION_COMPLETED /
 *      EXECUTION_HANDOFF_READY / EXECUTION_FAILED).
 *
 * The service NEVER mutates workflow state (that is /workflows' authority) and
 * never touches verification/review state.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  AuditService,
} from '@modules/audit/index.js';
import type {
  ExecutionProvider,
  ExecutionRecordRepository,
  ExecutionService,
  ExecutionSubmitResult,
  ExecutionTask,
  CreateExecutionRecordInput,
} from './execution.types.js';

export interface DefaultExecutionServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  /** Registered providers — exactly one per mode in production wiring. */
  readonly providers: readonly ExecutionProvider[];
  readonly auditService: AuditService;
  readonly logger: Logger;
}

export class DefaultExecutionService implements ExecutionService {
  constructor(private readonly deps: DefaultExecutionServiceDeps) {}

  async submit(task: ExecutionTask): Promise<ExecutionSubmitResult> {
    const provider = this.deps.providers.find((p) => p.mode === task.mode);
    if (!provider) {
      throw new Error(
        `execution-provider-not-registered: no ExecutionProvider is registered for mode "${task.mode}"`,
      );
    }

    const repositoryRef =
      task.repositoryOwner && task.repositoryName
        ? `${task.repositoryOwner}/${task.repositoryName}`
        : null;

    // 1. Persist the execution record BEFORE dispatching, so both outcomes
    //    (success + failure) are auditable benchmark data points.
    const createInput: CreateExecutionRecordInput = {
      executionId: task.executionId,
      projectId: task.projectId,
      workItemId: task.workItemId,
      workOrderId: task.workOrderId,
      implementationContextId: task.implementationContextId,
      mode: task.mode,
      provider: task.provider,
      model: task.model,
      repositoryRef,
      branch: task.implementationBranch,
      prompt: task.prompt,
      promptDigest: task.promptDigest,
      benchmarkMetadata: {
        mode: task.mode,
        provider: task.provider,
        model: task.model,
        implementationContextKind: task.implementationContextKind,
        implementationContextRevision: task.implementationContextRevision,
        promptDigest: task.promptDigest,
        // Benchmark placeholders enriched later (WORK-028+): CI failure count,
        // verification result, review result, time to VERIFIED.
      },
    };
    const record = await this.deps.executionRecordRepository.create(createInput);

    // 2. EXECUTION_CREATED — audit the submission itself.
    await this.emit(record.projectId, 'EXECUTION_CREATED', record.id, task, {
      status: record.status,
    });

    // 3. Dispatch through the provider boundary.
    let submission;
    try {
      submission = await provider.submit(task);
    } catch (err) {
      // Provider failure — persist + audit the failure, then propagate so the
      // route returns a failure response. No fake success.
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'failed',
        completedAt: new Date(),
        benchmarkMetadata: {
          failureStage: 'provider-submit',
          errorMessage: (err as Error).message,
        },
      });
      await this.emit(record.projectId, 'EXECUTION_FAILED', record.id, task, {
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      throw err;
    }

    // 4. Persist the provider outcome.
    if (submission.status === 'completed') {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'completed',
        agentRunId: submission.agentRunId ?? null,
        externalSessionRef: submission.externalSessionRef ?? null,
        startedAt: submission.startedAt ?? null,
        completedAt: submission.completedAt ?? null,
        benchmarkMetadata: {
          commitRef: submission.commitRef ?? null,
          pullRequestRef: submission.pullRequestRef ?? null,
        },
      });
    } else if (submission.status === 'handoff_ready') {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'handoff_ready',
        packageValue: submission.package ?? null,
        expiresAt: submission.expiresAt ?? null,
      });
    } else {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: submission.status,
        externalSessionRef: submission.externalSessionRef ?? null,
      });
    }

    // 5. Outcome audit event.
    const finalStatus =
      submission.status === 'completed'
        ? 'EXECUTION_COMPLETED'
        : submission.status === 'handoff_ready'
          ? 'EXECUTION_HANDOFF_READY'
          : 'EXECUTION_COMPLETED';
    await this.emit(record.projectId, finalStatus, record.id, task, {
      status: submission.status,
      agentRunId: submission.agentRunId ?? null,
      expiresAt: submission.expiresAt?.toISOString() ?? null,
    });

    this.deps.logger.info('execution.submitted', {
      executionId: task.executionId,
      mode: task.mode,
      provider: task.provider,
      status: submission.status,
      agentRunId: submission.agentRunId ?? null,
    });

    return {
      executionId: task.executionId,
      mode: task.mode,
      provider: task.provider,
      status: submission.status,
      agentRunId: submission.agentRunId ?? null,
      repositoryRef,
      branch: task.implementationBranch,
      expiresAt: submission.expiresAt ?? null,
      implementationContextId: task.implementationContextId,
    };
  }

  private async emit(
    projectId: string,
    eventType: string,
    resourceId: string,
    task: ExecutionTask,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.auditService.write({
        projectId,
        eventType,
        actor: 'system',
        source: 'execution-service',
        resourceType: 'execution',
        resourceId,
        executionId: task.executionId,
        workItemId: task.workItemId,
        workOrderId: task.workOrderId,
        metadata,
      });
    } catch (err) {
      // Audit emission must never break the execution flow (same policy as
      // the workflow engine's audit emitter).
      this.deps.logger.warn('execution.audit-write-failed', {
        eventType,
        executionId: task.executionId,
        error: (err as Error).message,
      });
    }
  }
}
