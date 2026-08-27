/**
 * WORK-027 + WORK-034: DefaultExecutionService.
 *
 * The single entry point for submitting an ExecutionTask through the provider
 * boundary. Flow:
 *
 *   1. Create the execution record (status 'created') with the deterministic
 *      prompt + digest and the initial benchmark metadata.
 *   2. Emit EXECUTION_CREATED audit event.
 *   2b. WORK-034 (when the optional sessionService is wired): ensure the ONE
 *      ExecutionSession for this record (idempotent — a retry reuses it) and
 *      CAS it created → running with a 'turn_started' session event (a CAS
 *      loser — e.g. a retry after the session already started — performs NO
 *      duplicate side effects).
 *   3. Dispatch to the ExecutionProvider matching the task's mode:
 *        native   → NativeExecutionProvider → AgentGateway (unchanged)
 *        external → ExternalExecutionProvider → deterministic package
 *      (Providers are NOT session-aware: session lifecycle stays /agents-
 *      owned; provider behavior stays provider-owned.)
 *   4. Persist the outcome on the execution record:
 *        native success   → status 'completed' + agentRunId (+timestamps)
 *        external         → status 'handoff_ready' + package + expiresAt
 *        provider failure → status 'failed' (native) — the error propagates
 *                           so the route returns a failure response.
 *   4b. WORK-034 session outcome (when wired): native completion → session
 *      CAS running → completed (+ 'completed' event); provider failure →
 *      session CAS running → failed (+ 'failed' event — a failure is never
 *      disguised as success). External handoff_ready leaves the session
 *      'running' (the external flow continues via the existing handoff/
 *      callback boundary; the ingestion terminal hook completes the session
 *      when the execution record reaches its terminal state).
 *
 * The service NEVER mutates workflow state (that is /workflows' authority) and
 * never touches verification/review state. A session reaching 'completed'
 * does NOT mean Work Item=VERIFIED (verification authority) or PR=MERGED
 * (GitHub authority).
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
  ExecutionAdmissionPort,
} from './execution.types.js';
import type { ExecutionSessionService } from './execution-session.types.js';

export interface DefaultExecutionServiceDeps {
  readonly executionRecordRepository: ExecutionRecordRepository;
  /** Registered providers — exactly one per mode in production wiring. */
  readonly providers: readonly ExecutionProvider[];
  readonly auditService: AuditService;
  readonly logger: Logger;
  /**
   * WORK-034: the session lifecycle boundary. OPTIONAL — the pre-WORK-034
   * wiring (no sessions) keeps working unchanged. When present, submit()
   * becomes session-aware: exactly one session per execution record
   * (idempotent), CAS start + turn_started, and session terminal outcomes
   * mirroring the execution outcome (native completion → completed;
   * provider failure → failed; external handoff → stays running until the
   * ingestion terminal hook). The session service never dispatches
   * execution — this service remains the single execution authority.
   */
  readonly sessionService?: ExecutionSessionService;
  readonly executionAdmission: ExecutionAdmissionPort;
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

    // 2b. WORK-034: establish the ONE session for this execution record
    //     (idempotent — a retry after a crash between record creation and
    //     here reuses the same session) and CAS it to running with a
    //     'turn_started' event. A CAS loss (the session already started —
    //     e.g. a retry) is a benign no-op: no duplicate event, no side
    //     effects. Errors propagate: the execution has not been dispatched
    //     yet, so failing fast is correct.
    if (this.deps.sessionService) {
      // The LOGICAL execution identity (task.executionId — the same id the
      // routes/gateway/external boundary use); the session service resolves
      // the record + creates the session with the record's OWN identity
      // tuple (callers cannot supply a mismatched linkage).
      const session = await this.deps.sessionService.ensureSession(task.executionId);
      await this.deps.sessionService.startSession(session.id);
    }

    // 3. Final hard-constraint admission immediately before provider dispatch.
    const admission = await this.deps.executionAdmission.admit(task);
    if (!admission.admitted) {
      const reason = admission.blockingReasons.map((b) => `${b.category}/${b.constraint}: ${b.reason}`).join('; ');
      throw new Error(`execution-admission-denied: ${admission.reason}${reason ? ` (${reason})` : ''}`);
    }

    // 3b. Dispatch through the provider boundary.
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
      // WORK-034: the session reflects the failure (running → failed +
      // 'failed' event) — best-effort + logged so the original provider
      // error still propagates cleanly. The execution record above is the
      // authoritative failure record either way.
      if (this.deps.sessionService) {
        try {
          await this.deps.sessionService.failSession(task.executionId, (err as Error).message);
        } catch (sessionErr) {
          this.deps.logger.error('execution.session-failure-mark-failed', {
            executionId: task.executionId,
            error: (sessionErr as Error).message,
          });
        }
      }
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
      // WORK-034: native completion → the session reaches its terminal
      // 'completed' state (+ event). Session completion does NOT mean Work
      // Item=VERIFIED or PR=MERGED — those remain /verification + GitHub
      // authority. Best-effort + logged: the execution record above is
      // authoritative; a session-terminal error must not lose the result.
      if (this.deps.sessionService) {
        try {
          await this.deps.sessionService.completeSession(task.executionId);
        } catch (sessionErr) {
          this.deps.logger.error('execution.session-completion-mark-failed', {
            executionId: task.executionId,
            error: (sessionErr as Error).message,
          });
        }
      }
    } else if (submission.status === 'handoff_ready') {
      await this.deps.executionRecordRepository.updateStatus(record.id, {
        status: 'handoff_ready',
        packageValue: submission.package ?? null,
        expiresAt: submission.expiresAt ?? null,
      });
      // WORK-034: the session STAYS 'running' — the external execution is
      // in flight through the existing handoff/callback boundary (the
      // session is observable through the same execution identity). The
      // ingestion terminal hook (composition root) CASes the session to
      // its terminal state when the execution record completes/fails via
      // the external event boundary.
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
