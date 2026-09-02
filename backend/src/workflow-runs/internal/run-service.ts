/**
 * V2-005 — the workflow run service: the ONE authority for durable Run state
 * and evidence (work order V2-005; the V2-002 service structural precedent).
 *
 * Composition:
 *
 *   - IDENTITY is derived deterministically BEFORE persistence
 *     (internal/identity.ts): identical authoritative inputs converge on
 *     byte-identical identities — duplicate run submissions (duplicate event
 *     delivery) converge structurally; divergent duplicate rows are
 *     unrepresentable (the migration's UNIQUE constraints agree).
 *   - PERSISTENCE is the PostgreSQL layer (internal/pg-run-store.ts +
 *     migration 0061): create-or-converge inserts, guarded CAS lifecycle
 *     transitions (the UPDATE is the serialization point), DB-level
 *     immutability/state-machine triggers, durable single-use replay state.
 *   - The WORKFLOW/VERSION PIN is resolved through the merged V2-002
 *     repository service (read-only, public barrel) and parsed with the
 *     merged V2-003 barrel (the semantic authority — this module never
 *     re-implements IR semantics). Repository read errors are mapped UNIFORML
 *     to RUN_VERSION_NOT_OF_WORKFLOW (missing / cross-workflow /
 *     visibility-denied are indistinguishable at this boundary — no existence
 *     leak).
 *   - TENANT SCOPING: every command and query is principal-scoped through the
 *     identity authority's membership facts (OrganizationMembershipResolver,
 *     consumed). Cross-tenant access is a uniform typed RUN_NOT_FOUND (zero
 *     leakage); acting inside a non-member organization is RUN_NOT_ORGANIZATION_MEMBER.
 *   - ATTESTATION BOUNDARY: attaching verifies through the merged V2-014
 *     verifier (verifyAttestation — the ONLY verification authority) with
 *     run-derived binding expectations (internal/attestation-boundary.ts)
 *     and a DB-snapshot replay registry; the DURABLE single-use consumption
 *     is THIS module's binding row (the INSERT is the consumption). Every
 *     rejection is a TYPED, durably recorded boundary rejection — never
 *     evidence. A valid signature with failed/insufficient verification is
 *     never auto-accepted (registry authorityRules).
 *
 * EXACTLY-ONCE COMMANDS (deterministic correlation + causation):
 *
 *   1. the command row is CLAIMED with a single autocommit
 *      INSERT ... ON CONFLICT (organization, command_id) DO NOTHING — the
 *      exactly-once boundary (the durable dedupe key);
 *   2. the first claimer executes the handler — every statement is
 *      independently convergent (idempotent writes + deterministic
 *      identities), so a crash between statements leaves a reconstructable
 *      partial state;
 *   3. the typed result is filled with the single sanctioned UPDATE
 *      (ok:true + value, or ok:false + code + message for typed rejections);
 *   4. a duplicate submission (same command id, same payload commitment)
 *      CONVERGES on the recorded outcome — no second side effect; with a
 *      different payload it is a typed RUN_COMMAND_PAYLOAD_CONFLICT;
 *   5. a claimed-but-unfilled row (the crash window) re-runs the handler in
 *      REPLAY mode: convergence-tolerant (a CAS miss onto the command's own
 *      target state proceeds; the remaining writes converge) — crash
 *      recovery without phantom side effects.
 *
 * ATTEMPT RULE (documented here, pinned by the attempt-policy battery):
 * attempt 1 begins at run start; an explicit PAUSE suspends the current
 * attempt and an explicit RESUME CONTINUES that same attempt at the exact
 * recorded step; a DECLARED interruption (interruptRunAttempt — the executor
 * reports the attempt lost) closes the attempt and the next resume RESTARTS
 * as a NEW attempt (crash-retry). The module never guesses a crash — it
 * records what the commanded execution path reports.
 */
import type {
  AttachRunAttestationInput,
  AttachRunAttestationResult,
  CompleteRunInput,
  DefaultWorkflowRunServiceDeps,
  FailRunInput,
  InterruptRunAttemptInput,
  LifecycleRunResult,
  PauseRunInput,
  RecordInvocationCompletedInput,
  RecordInvocationRequestedInput,
  RecordRunEvidenceInput,
  RecordRunEvidenceResult,
  RecordStepCompletedInput,
  RecordStepStartedInput,
  RequestRunInput,
  RequestRunResult,
  ResumeRunInput,
  ResumeRunResult,
  RunCapabilityInvocation,
  RunCommandEnvelope,
  RunCommandOutcome,
  RunCommandType,
  RunEvidenceClass,
  RunInvocationOutcome,
  RunStepExecution,
  RunTimelineEventName,
  StartRunInput,
  CancelRunInput,
  WorkflowRun,
  WorkflowRunHistory,
  WorkflowRunService,
  WorkflowPrincipal,
} from '../types.js';
import { WorkflowRunError } from '../types.js';
import type {
  ExecutionAttestation,
  ReplayRegistry,
} from '../../execution-attestation/index.js';
import {
  validateExecutionStatement,
  verifyAttestation,
} from '../../execution-attestation/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import {
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
} from '../../workflow-ir/index.js';
import type { WorkflowRepositoryService, WorkflowVersion } from '../../workflow-repository/index.js';
import { WorkflowRepositoryError } from '../../workflow-repository/index.js';
import { assertRunTransition, isTerminalRunState } from './run-state-machine.js';
import {
  assertRunCommandEnvelope,
  assertRunCommitmentList,
  assertRunEvidenceClass,
  assertRunEvidenceProducer,
  assertRunExecutionClass,
  assertRunCapabilityName,
  assertRunTrigger,
  commandPayloadDigest,
  evidenceTimelineEventName,
} from './run-validation.js';
import { buildRunAttestationVerificationPolicy } from './attestation-boundary.js';
import {
  deriveRunAttemptId,
  deriveRunCommandId,
  deriveRunEventId,
  deriveRunEvidenceId,
  deriveRunInvocationId,
  deriveRunRejectionId,
  deriveRunStepId,
  deriveWorkflowRunId,
  runInputDigest,
} from './identity.js';
import { decideResumeAction } from './attempt-policy.js';
import {
  mapAttemptRow,
  mapBindingRow,
  mapCommandRow,
  mapEventRow,
  mapEvidenceRow,
  mapInvocationRow,
  mapRejectionRow,
  mapRunRow,
  mapStepRow,
  PgWorkflowRunStore,
  type AttemptRow,
  type RunRow,
} from './pg-run-store.js';
import { validateRunStepDeclaration } from './step-validation.js';

/** The producer identity the run attestation boundary records evidence as. */
const RUN_BOUNDARY_VERIFIER_KIND = 'verifier';
const RUN_BOUNDARY_VERIFIER_ID = 'workflow-runs/attestation-boundary';

export class DefaultWorkflowRunService implements WorkflowRunService {
  private readonly store: PgWorkflowRunStore;
  private readonly memberships: DefaultWorkflowRunServiceDeps['memberships'];
  private readonly workflowRepository: WorkflowRepositoryService;
  private readonly clock: DefaultWorkflowRunServiceDeps['clock'];
  private readonly currentEpoch: number;

  constructor(deps: DefaultWorkflowRunServiceDeps) {
    this.store = new PgWorkflowRunStore(deps.db);
    this.memberships = deps.memberships;
    this.workflowRepository = deps.workflowRepository;
    this.clock = deps.clock;
    this.currentEpoch = deps.currentEpoch;
  }

  private now(): string {
    return this.clock.now();
  }

  // --- tenant scoping ---------------------------------------------------------

  private async isMember(userId: string, organizationId: string): Promise<boolean> {
    return this.memberships.isMember(userId, organizationId);
  }

  private async assertOrganizationMember(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<void> {
    if (!(await this.isMember(principal.userId, organizationId))) {
      throw new WorkflowRunError(
        'RUN_NOT_ORGANIZATION_MEMBER',
        `user ${principal.userId} is not a member of organization ${organizationId}`,
      );
    }
  }

  /**
   * The uniform tenant gate for run-scoped access: a missing run and a
   * cross-tenant run are INDISTINGUISHABLE (typed RUN_NOT_FOUND — zero
   * existence leakage).
   */
  private async requireRunRow(principal: WorkflowPrincipal, runId: string): Promise<RunRow> {
    const row = await this.store.findRunById(runId);
    if (!row || !(await this.isMember(principal.userId, row.organization_id))) {
      throw new WorkflowRunError('RUN_NOT_FOUND', `workflow run ${runId} does not exist`);
    }
    return row;
  }

  // --- the pinned version (V2-002 + V2-003 barrels, read-only) ----------------

  /**
   * Resolve the pinned version through the repository's public barrel. The
   * uniform mapping (missing / cross-workflow / visibility-denied →
   * RUN_VERSION_NOT_OF_WORKFLOW) keeps tuple-integrity failures
   * indistinguishable from unreadable pins — no existence leak.
   */
  private async resolvePinnedVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersion> {
    try {
      return await this.workflowRepository.getVersion(principal, workflowId, versionId);
    } catch (err) {
      if (
        err instanceof WorkflowRepositoryError &&
        (err.code === 'WORKFLOW_NOT_FOUND' ||
          err.code === 'WORKFLOW_VERSION_NOT_FOUND' ||
          err.code === 'WORKFLOW_NOT_VISIBLE')
      ) {
        throw new WorkflowRunError(
          'RUN_VERSION_NOT_OF_WORKFLOW',
          `version ${versionId} is not resolvable as a version of workflow ${workflowId} for this principal (the (workflow, version) tuple is structurally unrunnable)`,
        );
      }
      throw err;
    }
  }

  /**
   * Parse the pinned version's content with the merged V2-003 parser (the
   * semantic authority). Unparseable content is a typed boundary failure —
   * the run module never interprets raw content.
   */
  private parseVersionDocument(version: WorkflowVersion): WorkflowIrDocument {
    const parsed = parseWorkflowIrDocument(JSON.stringify(version.content));
    if (!parsed.ok) {
      const summary = parsed.issues.map((issue) => `${issue.code} at ${issue.path}`).join('; ');
      throw new WorkflowRunError(
        'RUN_VERSION_CONTENT_NOT_PARSEABLE',
        `the pinned version ${version.id} content is not a parseable WorkflowIR document (${summary})`,
      );
    }
    return parsed.document;
  }

  /** Resolve + parse the run's pinned version (for step-declared validation). */
  private async versionDocumentForRun(
    principal: WorkflowPrincipal,
    runRow: RunRow,
  ): Promise<WorkflowIrDocument> {
    const version = await this.resolvePinnedVersion(
      principal,
      runRow.workflow_id,
      runRow.version_id,
    );
    return this.parseVersionDocument(version);
  }

  /** Validate the installation/deployment reference against the pin. */
  private async assertInstallationPin(
    principal: WorkflowPrincipal,
    input: RequestRunInput,
  ): Promise<string | null> {
    if (input.installationId === undefined || input.installationId === null) {
      return null;
    }
    try {
      const detail = await this.workflowRepository.getInstallation(
        principal,
        input.organizationId,
        input.installationId,
      );
      const installation = detail.installation;
      if (
        installation.organizationId !== input.organizationId ||
        installation.workflowId !== input.workflowId ||
        installation.versionId !== input.versionId
      ) {
        throw new WorkflowRunError(
          'RUN_INSTALLATION_MISMATCH',
          `installation ${input.installationId} pins (${installation.workflowId}, ${installation.versionId}) — not the requested (${input.workflowId}, ${input.versionId})`,
        );
      }
      return installation.id;
    } catch (err) {
      if (err instanceof WorkflowRunError) throw err;
      if (err instanceof WorkflowRepositoryError) {
        throw new WorkflowRunError(
          'RUN_INSTALLATION_MISMATCH',
          `installation ${input.installationId} is not resolvable for organization ${input.organizationId} (${err.code})`,
        );
      }
      throw err;
    }
  }

  // --- the exactly-once command boundary ----------------------------------------

  /**
   * The command executor: claim → execute (convergent statements) → fill the
   * typed result. Duplicate submissions converge on the recorded outcome; a
   * same-id/different-payload submission is a typed conflict; a
   * claimed-but-unfilled row (the crash window) re-runs the handler in replay
   * mode (convergence-tolerant).
   */
  private async executeCommand<T>(
    envelope: RunCommandEnvelope,
    commandType: RunCommandType,
    organizationId: string,
    runScopeId: string | null,
    payload: unknown,
    handler: (mode: 'first' | 'replay') => Promise<T>,
  ): Promise<RunCommandOutcome<T>> {
    assertRunCommandEnvelope(envelope);
    const payloadDigest = commandPayloadDigest({ type: commandType, input: payload });
    const commandRowId = deriveRunCommandId({ organizationId, commandId: envelope.commandId });
    const claimed = await this.store.insertCommandOrConverge({
      id: commandRowId,
      organizationId,
      runId: runScopeId,
      commandId: envelope.commandId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId ?? null,
      commandType,
      payloadDigest,
      executedAt: this.now(),
    });

    if (!claimed.created) {
      const existing = claimed.row;
      if (existing.payload_digest !== payloadDigest) {
        throw new WorkflowRunError(
          'RUN_COMMAND_PAYLOAD_CONFLICT',
          `command id "${envelope.commandId}" was already submitted with a DIFFERENT payload (recorded commitment ${existing.payload_digest}, this submission ${payloadDigest}) — a command id is an exactly-once identity, never a reusable label`,
        );
      }
      const recorded = existing.result;
      if (recorded !== null && recorded !== undefined) {
        if (recorded.ok === true) {
          return { executed: false, commandId: envelope.commandId, result: recorded.value as T };
        }
        throw new WorkflowRunError(
          recorded.code as never,
          `converged rejection of command "${envelope.commandId}": ${recorded.message ?? ''}`,
        );
      }
      // The crash window: the command was claimed but its outcome was never
      // filled. Re-run the handler in replay mode — every statement is
      // convergent, so this completes the interrupted execution without a
      // second side effect.
      const value = await handler('replay');
      await this.store.fillCommandResult(commandRowId, { ok: true, value: value as never });
      return { executed: false, commandId: envelope.commandId, result: value };
    }

    try {
      const value = await handler('first');
      await this.store.fillCommandResult(commandRowId, { ok: true, value: value as never });
      return { executed: true, commandId: envelope.commandId, result: value };
    } catch (err) {
      if (err instanceof WorkflowRunError) {
        // Typed rejections are durably recorded (the command log proves the
        // rejection happened exactly once; a replay converges on it).
        await this.store.fillCommandResult(commandRowId, {
          ok: false,
          code: err.code,
          message: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * A run-scoped command: the tenant gate runs FIRST (uniform typed 404),
   * then the exactly-once boundary, then the handler (which re-reads the
   * current durable state — never a stale snapshot).
   */
  private async runScopedCommand<T>(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    commandType: RunCommandType,
    runId: string,
    payload: unknown,
    handler: (mode: 'first' | 'replay') => Promise<T>,
  ): Promise<RunCommandOutcome<T>> {
    const runRow = await this.requireRunRow(principal, runId);
    return this.executeCommand(envelope, commandType, runRow.organization_id, runRow.id, payload, handler);
  }

  /** Append one timeline entry (convergent on the deterministic event id). */
  private async recordTimeline(input: {
    readonly runId: string;
    readonly eventName: RunTimelineEventName;
    readonly subject: string;
    readonly attemptNumber?: number | null;
    readonly stepId?: string | null;
    readonly detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.store.insertTimelineEvent({
      id: deriveRunEventId({ runId: input.runId, eventName: input.eventName, subject: input.subject }),
      runId: input.runId,
      attemptNumber: input.attemptNumber ?? null,
      stepId: input.stepId ?? null,
      eventName: input.eventName,
      occurredAt: this.now(),
      detail: input.detail ?? null,
    });
  }

  /**
   * Pre-validate a lifecycle transition WITH replay convergence: in replay
   * mode (the crash-window re-run of an already-claimed command), the run
   * having ALREADY reached this command's own target state is CONVERGENCE,
   * not an error — the side effect this command exists to produce is already
   * durable (the command log will record it once).
   */
  private assertLifecycleTarget(
    runRow: RunRow,
    mode: 'first' | 'replay',
    to: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  ): void {
    if (mode === 'replay' && runRow.state === to) return;
    assertRunTransition(runRow.state, to);
  }

  /**
   * The lifecycle CAS wrapper: validate → guarded UPDATE → on a guard miss,
   * re-read and either converge (replay onto the command's own target state)
   * or re-validate against the CURRENT durable state (typed rejection).
   */
  private async transitionRun(
    runId: string,
    mode: 'first' | 'replay',
    from: string,
    to: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  ): Promise<RunRow> {
    const updated = await this.store.transitionRunState(runId, from as never, to, this.now());
    if (updated) return updated;
    const current = await this.requireCurrentRunRow(runId);
    if (mode === 'replay' && current.state === to) return current;
    assertRunTransition(current.state, to);
    throw new WorkflowRunError(
      'RUN_INVALID_STATE_TRANSITION',
      `the run transitioned concurrently (now "${current.state}"; this command required "${from}")`,
    );
  }

  /** Re-read the run row without the tenant gate (internal, already gated). */
  private async requireCurrentRunRow(runId: string): Promise<RunRow> {
    const row = await this.store.findRunById(runId);
    if (!row) {
      throw new WorkflowRunError('RUN_NOT_FOUND', `workflow run ${runId} does not exist`);
    }
    return row;
  }

  /** Steps/invocations are recordable only on an actively running run. */
  private assertExecutionOpen(runRow: RunRow): void {
    if (isTerminalRunState(runRow.state)) {
      throw new WorkflowRunError(
        'RUN_TERMINAL',
        `the run is in terminal state "${runRow.state}" — execution records are closed (evidence remains appendable)`,
      );
    }
    if (runRow.state !== 'running') {
      throw new WorkflowRunError(
        'RUN_NOT_RUNNING',
        `steps and invocations are recorded only while the run is actively running (state: "${runRow.state}")`,
      );
    }
  }

  /** The active (latest, running) attempt of a running run. */
  private async requireActiveAttempt(runRow: RunRow): Promise<AttemptRow> {
    const latest = await this.store.findLatestAttempt(runRow.id);
    if (!latest) {
      throw new WorkflowRunError(
        'RUN_ATTEMPT_NOT_FOUND',
        `workflow run ${runRow.id} has no execution attempt (a running run always carries one)`,
      );
    }
    if (latest.state !== 'running') {
      throw new WorkflowRunError(
        'RUN_NOT_RUNNING',
        `the latest attempt (#${latest.attemptNumber}, state "${latest.state}") is not actively running`,
      );
    }
    return latest;
  }

  // --- run lifecycle ------------------------------------------------------------

  async requestRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RequestRunInput,
  ): Promise<RunCommandOutcome<RequestRunResult>> {
    await this.assertOrganizationMember(principal, input.organizationId);
    assertRunTrigger(input.trigger);
    assertRunCommitmentList(input.inputCommitments);
    const inputDigest = runInputDigest(input.inputCommitments);
    // The deterministic run identity is derivable from the command inputs
    // alone — the command log's run scope is known before execution.
    const runId = deriveWorkflowRunId({
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      versionId: input.versionId,
      triggerType: input.trigger.type,
      triggerId: input.trigger.id,
      inputDigest,
    });
    return this.executeCommand(envelope, 'request_run', input.organizationId, runId, input, async () => {
      // The pin resolution: the EXACT (workflow, version) tuple through the
      // repository (uniform typed rejection), parsed by the merged V2-003
      // parser, with the semantic digest computed by the semantic authority.
      const version = await this.resolvePinnedVersion(principal, input.workflowId, input.versionId);
      const document = this.parseVersionDocument(version);
      const semanticDigest = computeWorkflowVersionSemanticDigest(document);
      const installationId = await this.assertInstallationPin(principal, input);
      const inserted = await this.store.insertRunOrConverge({
        id: runId,
        organizationId: input.organizationId,
        workflowId: input.workflowId,
        versionId: input.versionId,
        versionContentDigest: version.contentDigest,
        versionSemanticDigest: semanticDigest.digest,
        installationId,
        triggerType: input.trigger.type,
        triggerId: input.trigger.id,
        triggeredByUserId: principal.userId,
        inputCommitments: input.inputCommitments,
        inputDigest,
        createdAt: this.now(),
      });
      await this.recordTimeline({
        runId,
        eventName: 'workflow.run.requested',
        // The request event is identified by the TRIGGER surface (duplicate
        // event delivery converges on ONE requested event).
        subject: `trigger:${input.trigger.type}:${input.trigger.id}`,
        detail: { triggerType: input.trigger.type, triggerId: input.trigger.id },
      });
      return { run: mapRunRow(inserted.row), created: inserted.created };
    });
  }

  async startRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: StartRunInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'start_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'running');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'running');
      const attemptId = deriveRunAttemptId({ runId: input.runId, attemptNumber: 1 });
      const attempt = await this.store.insertAttemptOrConverge({
        id: attemptId,
        runId: input.runId,
        attemptNumber: 1,
        state: 'running',
        nodeId: input.nodeId ?? null,
        startedAt: this.now(),
      });
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.run.started',
        subject: envelope.commandId,
        attemptNumber: 1,
        detail: { nodeId: input.nodeId ?? null },
      });
      return { run: mapRunRow(updated), attempt: mapAttemptRow(attempt.row) };
    });
  }

  async pauseRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: PauseRunInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'pause_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'paused');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'paused');
      const latest = await this.store.findLatestAttempt(input.runId);
      let attemptRow: AttemptRow | null = latest;
      if (latest) {
        // The executor's report of WHERE execution stands (recorded
        // honestly; step-level declaration is validated on step records).
        const suspended = await this.store.suspendAttempt(latest.id, {
          pausedAtStepId: input.atStepId ?? null,
        });
        attemptRow =
          suspended ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.run.paused',
        subject: envelope.commandId,
        attemptNumber: latest?.attempt_number ?? null,
        detail: { atStepId: input.atStepId ?? null },
      });
      return {
        run: mapRunRow(updated),
        attempt: attemptRow === null ? null : mapAttemptRow(attemptRow),
      };
    });
  }

  async resumeRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: ResumeRunInput,
  ): Promise<RunCommandOutcome<ResumeRunResult>> {
    return this.runScopedCommand(principal, envelope, 'resume_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'running');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'running');
      const latest = await this.store.findLatestAttempt(input.runId);
      const action = decideResumeAction(
        latest ? { state: latest.state, attemptNumber: latest.attempt_number } : null,
      );
      let attemptRow: AttemptRow;
      let resumedAtStepId: string | null = null;
      let newAttempt: boolean;
      if (action.kind === 'continue' && latest) {
        // Resume-to-exact-step: the SAME attempt continues where it suspended.
        resumedAtStepId = latest.paused_at_step_id;
        newAttempt = false;
        const continued = await this.store.continueAttempt(latest.id, { nodeId: input.nodeId ?? null });
        attemptRow =
          continued ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      } else {
        // Crash-retry: a NEW attempt restarts execution (history keeps all).
        const attemptId = deriveRunAttemptId({
          runId: input.runId,
          attemptNumber: action.attemptNumber,
        });
        const inserted = await this.store.insertAttemptOrConverge({
          id: attemptId,
          runId: input.runId,
          attemptNumber: action.attemptNumber,
          state: 'running',
          nodeId: input.nodeId ?? null,
          startedAt: this.now(),
        });
        attemptRow = inserted.row;
        newAttempt = true;
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.run.resumed',
        subject: envelope.commandId,
        attemptNumber: attemptRow.attempt_number,
        detail: { newAttempt, resumedAtStepId },
      });
      return {
        run: mapRunRow(updated),
        attempt: mapAttemptRow(attemptRow),
        resumedAtStepId,
        newAttempt,
      };
    });
  }

  async interruptRunAttempt(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: InterruptRunAttemptInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'interrupt_attempt', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'paused');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'paused');
      const latest = await this.store.findLatestAttempt(input.runId);
      let attemptRow: AttemptRow | null = latest;
      if (latest) {
        const ended = await this.store.endAttempt(latest.id, 'interrupted', this.now());
        attemptRow =
          ended ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'run.attempt.interrupted',
        subject: envelope.commandId,
        attemptNumber: latest?.attempt_number ?? null,
        detail: { reason: input.reason ?? null },
      });
      return {
        run: mapRunRow(updated),
        attempt: attemptRow === null ? null : mapAttemptRow(attemptRow),
      };
    });
  }

  async cancelRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: CancelRunInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'cancel_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'cancelled');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'cancelled');
      const latest = await this.store.findLatestAttempt(input.runId);
      let attemptRow: AttemptRow | null = latest;
      if (latest && latest.state !== 'ended') {
        const ended = await this.store.endAttempt(latest.id, 'ended', this.now());
        attemptRow =
          ended ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'run.cancelled',
        subject: envelope.commandId,
        attemptNumber: latest?.attempt_number ?? null,
        detail: { reason: input.reason ?? null },
      });
      return {
        run: mapRunRow(updated),
        attempt: attemptRow === null ? null : mapAttemptRow(attemptRow),
      };
    });
  }

  async completeRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: CompleteRunInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'complete_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'completed');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'completed');
      const latest = await this.store.findLatestAttempt(input.runId);
      let attemptRow: AttemptRow | null = latest;
      if (latest && latest.state !== 'ended') {
        const ended = await this.store.endAttempt(latest.id, 'ended', this.now());
        attemptRow =
          ended ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.run.completed',
        subject: envelope.commandId,
        attemptNumber: latest?.attempt_number ?? null,
        // The executor's CLAIMED outputs (a claim, never side-effect evidence).
        detail: { outputCommitments: input.outputCommitments ?? [] },
      });
      return {
        run: mapRunRow(updated),
        attempt: attemptRow === null ? null : mapAttemptRow(attemptRow),
      };
    });
  }

  async failRun(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: FailRunInput,
  ): Promise<RunCommandOutcome<LifecycleRunResult>> {
    return this.runScopedCommand(principal, envelope, 'fail_run', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertLifecycleTarget(runRow, mode, 'failed');
      const updated = await this.transitionRun(input.runId, mode, runRow.state, 'failed');
      const latest = await this.store.findLatestAttempt(input.runId);
      let attemptRow: AttemptRow | null = latest;
      if (latest && latest.state !== 'ended') {
        const ended = await this.store.endAttempt(latest.id, 'ended', this.now());
        attemptRow =
          ended ?? ((await this.store.findAttempt(input.runId, latest.attempt_number)) ?? latest);
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.run.failed',
        subject: envelope.commandId,
        attemptNumber: latest?.attempt_number ?? null,
        detail: { reason: input.reason ?? null },
      });
      return {
        run: mapRunRow(updated),
        attempt: attemptRow === null ? null : mapAttemptRow(attemptRow),
      };
    });
  }

  // --- execution records ---------------------------------------------------------

  async recordStepStarted(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RecordStepStartedInput,
  ): Promise<RunCommandOutcome<{ step: RunStepExecution }>> {
    return this.runScopedCommand(principal, envelope, 'record_step_started', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertExecutionOpen(runRow);
      const document = await this.versionDocumentForRun(principal, runRow);
      const declared = validateRunStepDeclaration(document, input.stepId);
      if (!declared.ok) {
        throw new WorkflowRunError(
          'RUN_STEP_NOT_DECLARED',
          `step "${input.stepId}" is not declared by the run's pinned WorkflowVersion ${runRow.version_id}`,
        );
      }
      const attempt = await this.requireActiveAttempt(runRow);
      const inserted = await this.store.insertStepOrConverge({
        id: deriveRunStepId({
          runId: input.runId,
          attemptNumber: attempt.attempt_number,
          stepId: input.stepId,
        }),
        runId: input.runId,
        attemptNumber: attempt.attempt_number,
        stepId: input.stepId,
        inputCommitments: input.inputCommitments ?? [],
        startedAt: this.now(),
      });
      if (!inserted.created && mode !== 'replay') {
        throw new WorkflowRunError(
          'RUN_STEP_ALREADY_RECORDED',
          `step "${input.stepId}" already has a started record in attempt #${attempt.attempt_number} of run ${input.runId}`,
        );
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.step.started',
        subject: envelope.commandId,
        attemptNumber: attempt.attempt_number,
        stepId: input.stepId,
        detail: { executionClass: declared.executionClass },
      });
      return { step: mapStepRow(inserted.row) };
    });
  }

  async recordStepCompleted(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RecordStepCompletedInput,
  ): Promise<RunCommandOutcome<{ step: RunStepExecution }>> {
    return this.runScopedCommand(principal, envelope, 'record_step_completed', input.runId, input, async (mode) => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      this.assertExecutionOpen(runRow);
      const document = await this.versionDocumentForRun(principal, runRow);
      const declared = validateRunStepDeclaration(document, input.stepId);
      if (!declared.ok) {
        throw new WorkflowRunError(
          'RUN_STEP_NOT_DECLARED',
          `step "${input.stepId}" is not declared by the run's pinned WorkflowVersion ${runRow.version_id}`,
        );
      }
      const attempt = await this.requireActiveAttempt(runRow);
      const existing = await this.store.findStep(input.runId, attempt.attempt_number, input.stepId);
      if (!existing) {
        throw new WorkflowRunError(
          'RUN_STEP_NOT_DECLARED',
          `step "${input.stepId}" has no started record in attempt #${attempt.attempt_number} of run ${input.runId} (steps complete from a started record)`,
        );
      }
      const outcome: RunInvocationOutcome = input.outcome;
      const targetStatus = outcome === 'succeeded' ? 'completed' : 'failed';
      if (existing.status !== 'started') {
        // Replay convergence: the crash-window re-run of an already-claimed
        // command converges when the step is already in THIS command's own
        // target state (the side effect is durable; first-mode duplicates of
        // a DIFFERENT command stay typed rejections).
        if (mode === 'replay' && existing.status === targetStatus && existing.outcome === outcome) {
          await this.recordTimeline({
            runId: input.runId,
            eventName: 'workflow.step.completed',
            subject: envelope.commandId,
            attemptNumber: attempt.attempt_number,
            stepId: input.stepId,
            detail: { outcome },
          });
          return { step: mapStepRow(existing) };
        }
        throw new WorkflowRunError(
          'RUN_STEP_ALREADY_RECORDED',
          `step "${input.stepId}" is already ${existing.status} in attempt #${attempt.attempt_number}`,
        );
      }
      const updated = await this.store.updateStepCompletion(existing.id, {
        status: outcome === 'succeeded' ? 'completed' : 'failed',
        outcome,
        outputCommitments: input.outputCommitments ?? [],
        completedAt: this.now(),
      });
      if (!updated) {
        const current = await this.store.findStep(input.runId, attempt.attempt_number, input.stepId);
        throw new WorkflowRunError(
          'RUN_STEP_ALREADY_RECORDED',
          `step "${input.stepId}" completed concurrently in attempt #${attempt.attempt_number} (status: ${current?.status ?? 'unknown'})`,
        );
      }
      await this.recordTimeline({
        runId: input.runId,
        eventName: 'workflow.step.completed',
        subject: envelope.commandId,
        attemptNumber: attempt.attempt_number,
        stepId: input.stepId,
        detail: { outcome },
      });
      return { step: mapStepRow(updated) };
    });
  }

  async recordInvocationRequested(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RecordInvocationRequestedInput,
  ): Promise<RunCommandOutcome<{ invocation: RunCapabilityInvocation }>> {
    assertRunCapabilityName(input.capability);
    assertRunExecutionClass(input.executionClass);
    assertRunCommitmentList(input.inputCommitments ?? []);
    return this.runScopedCommand(
      principal,
      envelope,
      'record_invocation_requested',
      input.runId,
      input,
      async () => {
        const runRow = await this.requireCurrentRunRow(input.runId);
        this.assertExecutionOpen(runRow);
        const document = await this.versionDocumentForRun(principal, runRow);
        if (input.stepId !== undefined) {
          const declared = validateRunStepDeclaration(document, input.stepId);
          if (!declared.ok) {
            throw new WorkflowRunError(
              'RUN_STEP_NOT_DECLARED',
              `step "${input.stepId}" is not declared by the run's pinned WorkflowVersion ${runRow.version_id}`,
            );
          }
        }
        const attempt = await this.requireActiveAttempt(runRow);
        const invocationId = deriveRunInvocationId({
          runId: input.runId,
          attemptNumber: attempt.attempt_number,
          stepId: input.stepId ?? null,
          capability: input.capability,
          commandId: envelope.commandId,
        });
        const inserted = await this.store.insertInvocationOrConverge({
          id: invocationId,
          runId: input.runId,
          attemptNumber: attempt.attempt_number,
          stepId: input.stepId ?? null,
          capability: input.capability,
          executionClass: input.executionClass,
          inputCommitments: input.inputCommitments ?? [],
          requestedAt: this.now(),
        });
        await this.recordTimeline({
          runId: input.runId,
          eventName: 'capability.invocation.requested',
          subject: invocationId,
          attemptNumber: attempt.attempt_number,
          stepId: input.stepId ?? null,
          detail: { capability: input.capability, executionClass: input.executionClass },
        });
        return { invocation: mapInvocationRow(inserted.row) };
      },
    );
  }

  async recordInvocationCompleted(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RecordInvocationCompletedInput,
  ): Promise<RunCommandOutcome<{ invocation: RunCapabilityInvocation }>> {
    return this.runScopedCommand(
      principal,
      envelope,
      'record_invocation_completed',
      input.runId,
      input,
      async (mode) => {
        const runRow = await this.requireCurrentRunRow(input.runId);
        this.assertExecutionOpen(runRow);
        const existing = await this.store.findInvocation(input.runId, input.invocationId);
        if (!existing) {
          throw new WorkflowRunError(
            'RUN_INVOCATION_NOT_FOUND',
            `capability invocation ${input.invocationId} does not exist in run ${input.runId}`,
          );
        }
        if (existing.outcome !== null) {
          // Replay convergence: the crash-window re-run of an already-claimed
          // command converges when the invocation is already completed with
          // THIS command's own outcome (first-mode duplicates stay typed).
          if (mode === 'replay' && existing.outcome === input.outcome) {
            await this.recordTimeline({
              runId: input.runId,
              eventName: 'capability.invocation.completed',
              subject: input.invocationId,
              attemptNumber: existing.attempt_number,
              stepId: existing.step_id,
              detail: { capability: existing.capability, outcome: input.outcome },
            });
            return { invocation: mapInvocationRow(existing) };
          }
          throw new WorkflowRunError(
            'RUN_INVOCATION_ALREADY_COMPLETED',
            `capability invocation ${input.invocationId} is already completed (outcome: ${existing.outcome})`,
          );
        }
        const updated = await this.store.updateInvocationCompletion(existing.id, {
          outcome: input.outcome,
          outputCommitments: input.outputCommitments ?? [],
          completedAt: this.now(),
        });
        if (!updated) {
          throw new WorkflowRunError(
            'RUN_INVOCATION_ALREADY_COMPLETED',
            `capability invocation ${input.invocationId} completed concurrently`,
          );
        }
        await this.recordTimeline({
          runId: input.runId,
          eventName: 'capability.invocation.completed',
          subject: input.invocationId,
          attemptNumber: updated.attempt_number,
          stepId: updated.step_id,
          detail: { capability: updated.capability, outcome: input.outcome },
        });
        return { invocation: mapInvocationRow(updated) };
      },
    );
  }

  // --- evidence -------------------------------------------------------------------

  async recordEvidence(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: RecordRunEvidenceInput,
  ): Promise<RunCommandOutcome<RecordRunEvidenceResult>> {
    assertRunEvidenceClass(input.evidenceClass);
    assertRunEvidenceProducer(input);
    assertRunCommitmentList([input.contentCommitment]);
    return this.runScopedCommand(principal, envelope, 'record_evidence', input.runId, input, async () => {
      const runRow = await this.requireCurrentRunRow(input.runId);
      // Evidence is appendable in ANY run state (terminal runs stay
      // evidence-appendable — only the lifecycle is immutable).
      if (input.stepId !== undefined) {
        const document = await this.versionDocumentForRun(principal, runRow);
        const declared = validateRunStepDeclaration(document, input.stepId);
        if (!declared.ok) {
          throw new WorkflowRunError(
            'RUN_STEP_NOT_DECLARED',
            `step "${input.stepId}" is not declared by the run's pinned WorkflowVersion ${runRow.version_id}`,
          );
        }
      }
      if (input.attemptNumber !== undefined) {
        const attempt = await this.store.findAttempt(input.runId, input.attemptNumber);
        if (!attempt) {
          throw new WorkflowRunError(
            'RUN_ATTEMPT_NOT_FOUND',
            `attempt #${input.attemptNumber} does not exist in run ${input.runId}`,
          );
        }
      }
      const evidenceId = deriveRunEvidenceId({
        runId: input.runId,
        evidenceClass: input.evidenceClass,
        producerKind: input.producerKind,
        producerId: input.producerId,
        contentCommitment: input.contentCommitment,
      });
      const inserted = await this.store.insertEvidenceOrConverge({
        id: evidenceId,
        runId: input.runId,
        attemptNumber: input.attemptNumber ?? null,
        stepId: input.stepId ?? null,
        evidenceClass: input.evidenceClass,
        producerKind: input.producerKind,
        producerId: input.producerId,
        contentCommitment: input.contentCommitment,
        description: input.description ?? null,
        recordedAt: this.now(),
      });
      const eventName = evidenceTimelineEventName(input.evidenceClass as RunEvidenceClass);
      if (eventName !== null) {
        // The registry event projection: observation → observation.recorded;
        // verification → verification.completed; the other classes are
        // evidence records with NO protocol event (classes never impersonate
        // one another).
        await this.recordTimeline({
          runId: input.runId,
          eventName,
          subject: evidenceId,
          attemptNumber: input.attemptNumber ?? null,
          stepId: input.stepId ?? null,
          detail: { evidenceClass: input.evidenceClass, producerId: input.producerId },
        });
      }
      return { evidence: mapEvidenceRow(inserted.row), created: inserted.created };
    });
  }

  // --- the attestation boundary (V2-014 verifier + durable single-use state) ----

  /**
   * Record a typed boundary rejection (append-only audit) and raise the typed
   * run error — a rejected attestation is NEVER evidence.
   */
  private async rejectAttestation(
    input: { runId: string; commandId: string },
    attestationId: string | null,
    failureCode: string,
    detail: string,
  ): Promise<never> {
    await this.store.insertRejection({
      id: deriveRunRejectionId({ runId: input.runId, attestationId, failureCode, commandId: input.commandId }),
      runId: input.runId,
      attestationId,
      failureCode,
      detail,
      rejectedAt: this.now(),
    });
    throw new WorkflowRunError(
      'RUN_ATTESTATION_REJECTED',
      `attestation ${attestationId ?? '<unrecoverable>'} rejected at the run boundary — ${failureCode}: ${detail}`,
    );
  }

  async attachAttestation(
    principal: WorkflowPrincipal,
    envelope: RunCommandEnvelope,
    input: AttachRunAttestationInput,
  ): Promise<RunCommandOutcome<AttachRunAttestationResult>> {
    return this.runScopedCommand(
      principal,
      envelope,
      'attach_attestation',
      input.runId,
      { ...input, attestation: '<ExecutionAttestation envelope>' },
      async (mode) => {
        const runRow = await this.requireCurrentRunRow(input.runId);
        const run = mapRunRow(runRow);
        const attestation = input.attestation;

        // 1. Statement-level structural validation (V2-014's own validator).
        const statementValidation = validateExecutionStatement(attestation.statement);
        if (!statementValidation.ok) {
          await this.rejectAttestation(
            { runId: input.runId, commandId: envelope.commandId },
            attestation.attestationId ?? null,
            'ATTESTATION_MALFORMED_STATEMENT',
            statementValidation.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; '),
          );
        }

        // 2. Run-boundary binding check: the attempt must be a REAL attempt
        //    of THIS run (the statement's run/attempt identity must describe
        //    the record it is attached to).
        const attemptRow = await this.store.findAttempt(input.runId, input.attemptNumber);
        if (!attemptRow) {
          await this.rejectAttestation(
            { runId: input.runId, commandId: envelope.commandId },
            attestation.attestationId,
            'ATTESTATION_BINDING_MISMATCH',
            `the attach targets attempt #${input.attemptNumber}, which is not an attempt of run ${input.runId}`,
          );
        }

        // 3. Durable replay convergence: a binding for THIS attestation
        //    already exists on the run. A first-mode delivery is a durable
        //    single-use rejection; a replay-mode delivery (the crash window
        //    between the binding insert and the result fill) converges on
        //    the persisted records.
        const existing = await this.store.findBindingByAttestation(
          input.runId,
          attestation.attestationId,
        );
        if (existing) {
          if (mode === 'replay') {
            const evidenceShape = this.attachEvidenceShape(input.runId, attestation);
            const evidence = await this.store.insertEvidenceOrConverge({
              ...evidenceShape,
              recordedAt: this.now(),
            });
            await this.recordAttachTimeline(input, attestation, evidence.row.id, existing.attempt_number);
            return {
              binding: mapBindingRow(existing),
              evidence: mapEvidenceRow(evidence.row),
            };
          }
          await this.rejectAttestation(
            { runId: input.runId, commandId: envelope.commandId },
            attestation.attestationId,
            'ATTESTATION_REPLAYED',
            `the single-use nonce for (run ${input.runId}, attempt ${String(input.attemptNumber)}) was already consumed — the persisted binding row IS the durable consumption (V2-014 reference registry was in-memory only)`,
          );
        }

        // 4. Step-scoped attaches must reference a step the pinned version
        //    DECLARES (the binding describes the record it attaches to).
        if (input.stepId !== undefined) {
          const document = await this.versionDocumentForRun(principal, runRow);
          const declared = validateRunStepDeclaration(document, input.stepId);
          if (!declared.ok) {
            await this.rejectAttestation(
              { runId: input.runId, commandId: envelope.commandId },
              attestation.attestationId,
              'ATTESTATION_BINDING_MISMATCH',
              `the attach is step-scoped to "${input.stepId}", which is not declared by the run's pinned WorkflowVersion`,
            );
          }
        }

        // 5. Verify through the merged V2-014 verifier (the ONLY verification
        //    authority) with run-derived binding expectations + a DB-snapshot
        //    replay registry (the durable consumption is the binding INSERT).
        const consumedKeys = await this.store.loadConsumedNonces(input.runId);
        const replayRegistry: ReplayRegistry = {
          isConsumed: (binding) =>
            consumedKeys.has(`${binding.runId}:${binding.attemptId}:${binding.nonce}`),
          consume: () => {
            // The durable consumption is the binding-row INSERT below (in
            // this same command); the in-memory marker is not the authority.
          },
        };
        const now = this.now();
        const policy = buildRunAttestationVerificationPolicy(
          run,
          {
            attemptNumber: input.attemptNumber,
            stepId: input.stepId,
            policy: input.policy,
          },
          { now, currentEpoch: this.currentEpoch, replayRegistry },
        );
        const verification = verifyAttestation(attestation, policy);
        if (!verification.ok) {
          const failure = verification.failure;
          await this.rejectAttestation(
            { runId: input.runId, commandId: envelope.commandId },
            failure.attestationId ?? attestation.attestationId,
            failure.code,
            failure.detail,
          );
        }

        // 6. The durable single-use consumption: the INSERT is the
        //    consumption (UNIQUE attestation identity + (run, attempt,
        //    nonce)); a concurrent winner surfaces as a durable replay.
        const inserted = await this.store.insertBindingOrConverge({
          attestationId: attestation.attestationId,
          runId: input.runId,
          attemptNumber: input.attemptNumber,
          stepId: input.stepId ?? null,
          executionDigest: attestation.executionDigest.digest,
          attesterKeyId: attestation.attesterKeyId,
          assurance: attestation.assurance,
          nonce: attestation.statement.nonce,
          statement: attestation.statement as unknown as Record<string, unknown>,
          verifiedAt: now,
          attachedAt: now,
        });
        if (!inserted.created || !inserted.row) {
          await this.rejectAttestation(
            { runId: input.runId, commandId: envelope.commandId },
            attestation.attestationId,
            'ATTESTATION_REPLAYED',
            'the attestation identity was already consumed durably (single-use consumption exists)',
          );
        }
        const bindingRow = inserted.row!;

        // 7. The boundary-verified fact records DISTINCT verification-class
        //    evidence (the ExecutionDigest commitment — one-way by V2-014
        //    construction) + the registry timeline events.
        const evidenceShape = this.attachEvidenceShape(input.runId, attestation);
        const evidence = await this.store.insertEvidenceOrConverge({
          ...evidenceShape,
          recordedAt: now,
        });
        await this.recordAttachTimeline(input, attestation, evidence.row.id, input.attemptNumber);
        return {
          binding: mapBindingRow(bindingRow),
          evidence: mapEvidenceRow(evidence.row),
        };
      },
    );
  }

  /** The verification-evidence record shape an attach records. */
  private attachEvidenceShape(runId: string, attestation: ExecutionAttestation): {
    id: string;
    runId: string;
    attemptNumber: number | null;
    stepId: string | null;
    evidenceClass: 'verification';
    producerKind: string;
    producerId: string;
    contentCommitment: string;
    description: string | null;
  } {
    return {
      id: deriveRunEvidenceId({
        runId,
        evidenceClass: 'verification',
        producerKind: RUN_BOUNDARY_VERIFIER_KIND,
        producerId: RUN_BOUNDARY_VERIFIER_ID,
        contentCommitment: attestation.executionDigest.digest,
      }),
      runId,
      attemptNumber: null,
      stepId: null,
      evidenceClass: 'verification',
      producerKind: RUN_BOUNDARY_VERIFIER_KIND,
      producerId: RUN_BOUNDARY_VERIFIER_ID,
      contentCommitment: attestation.executionDigest.digest,
      description: 'boundary-verified execution attestation (V2-014 verifier outcome; the ExecutionDigest is the content commitment)',
    };
  }

  private async recordAttachTimeline(
    input: AttachRunAttestationInput,
    attestation: ExecutionAttestation,
    evidenceId: string,
    attemptNumber: number,
  ): Promise<void> {
    await this.recordTimeline({
      runId: input.runId,
      eventName: 'execution.attestation.verified',
      subject: attestation.attestationId,
      attemptNumber,
      stepId: input.stepId ?? null,
      detail: {
        attestationId: attestation.attestationId,
        executionDigest: attestation.executionDigest.digest,
        attesterKeyId: attestation.attesterKeyId,
        assurance: attestation.assurance,
      },
    });
    await this.recordTimeline({
      runId: input.runId,
      eventName: 'verification.completed',
      subject: evidenceId,
      attemptNumber,
      stepId: input.stepId ?? null,
      detail: { evidenceId, evidenceClass: 'verification' },
    });
  }

  // --- reads (tenant-scoped) -------------------------------------------------------

  async getRun(principal: WorkflowPrincipal, runId: string): Promise<WorkflowRun> {
    const runRow = await this.requireRunRow(principal, runId);
    return mapRunRow(runRow);
  }

  async getRunHistory(principal: WorkflowPrincipal, runId: string): Promise<WorkflowRunHistory> {
    const runRow = await this.requireRunRow(principal, runId);
    const [timeline, attempts, steps, invocations, evidence, attestations, rejections, commands] =
      await Promise.all([
        this.store.listTimeline(runId),
        this.store.listAttempts(runId),
        this.store.listSteps(runId),
        this.store.listInvocations(runId),
        this.store.listEvidence(runId),
        this.store.listAttestationBindings(runId),
        this.store.listRejections(runId),
        this.store.listCommandsForRun(runId),
      ]);
    return {
      run: mapRunRow(runRow),
      timeline: timeline.map(mapEventRow),
      attempts: attempts.map(mapAttemptRow),
      steps: steps.map(mapStepRow),
      invocations: invocations.map(mapInvocationRow),
      evidence: evidence.map(mapEvidenceRow),
      attestations: attestations.map(mapBindingRow),
      attestationRejections: rejections.map(mapRejectionRow),
      commands: commands.map(mapCommandRow),
    };
  }

  async listRunsInOrganization(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<WorkflowRun[]> {
    await this.assertOrganizationMember(principal, organizationId);
    const rows = await this.store.listRunsInOrganization(organizationId);
    return rows.map(mapRunRow);
  }
}
