/**
 * WORK-036: DefaultToolRuntime — the governed tool boundary BENEATH the
 * execution/session/workspace authority.
 *
 * THE FLOW (invoke — native):
 *
 *   resolve session (must exist + be 'running' — a turn is active)
 *     → resolve the WORK-035 workspace (must exist + be 'ready')
 *     → resolve the worktree host path (the materializer's idempotent
 *       re-resolution — the same instance the workspace service uses)
 *     → replay check (a completed observation for the invocationId is
 *       returned AS-IS — the idempotent no-duplicate-effect contract)
 *     → DURABLE CLAIM (claimToolInvocation under the session row lock —
 *       cross-process, exactly one claimant per invocation key)
 *     → POLICY GATE (the WORK-037 seam: deny/ask → 'blocked', constrained
 *       → tightened limits / read-only)
 *     → EXECUTE (the platform executor for the family, workspace-confined)
 *     → OBSERVE (appendToolObservation — idempotent on the key) + audit
 *
 * CRASH/RETRY SEMANTICS (explicit):
 *   * completed observation + retry → REPLAY (no second logical effect).
 *   * dangling claim marker (crash between claim and observation):
 *     idempotent → re-run safely; non-idempotent → the typed 'unknown'
 *     status is OBSERVED durably (never a false success — the caller
 *     escalates with a new invocationId if they choose to re-run).
 *   * session terminalized mid-flight → the observation append throws
 *     'tool-runtime-observation-write-failed' WITH the unobservable
 *     outcome in the context (the tool RAN; the evidence could not land —
 *     honest, never silently successful).
 *   * interruption → the caller's AbortSignal cancels the in-flight tool
 *     (process kill / request abort / driver stop); the outcome is
 *     'cancelled' + observed; resumption is a NEW invocation.
 *
 * recordExternalObservation (external parity): appends the provider-side
 * normalized observation to the SAME session evidence log. It executes
 * NOTHING, requires NO workspace (the provider-native environment ran the
 * tool), and mutates NO WorkflowOS state — observation only.
 *
 * This service creates NO execution engine, NO provider registry, NO
 * permission engine, NO scheduler, and NO GitHub authority. Tool outcomes
 * are evidence; they never decide workflow/verification/review/merge/
 * architecture state.
 */
import type { Logger } from '@platform/logger.js';
import type { AuditEventWriter } from '@modules/audit/index.js';
import type { WorktreeMaterializer } from '@platform/workspace/worktree-materializer.types.js';
import type {
  FilesystemToolRequest,
  GitToolRequest,
  HttpToolRequest,
  PackageToolRequest,
  TerminalToolRequest,
  ToolExecutionLimits,
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutionOutcome,
  ToolFamily,
  ToolFamilyRequest,
  BrowserToolRequest,
} from '@platform/tools/tool-contracts.js';
import { DEFAULT_TOOL_EXECUTION_LIMITS } from '@platform/tools/tool-contracts.js';
import { redactForObservation, redactHttpHeaders } from '@platform/tools/observation-redaction.js';
import type {
  AgentWorkspaceRepository,
} from './agent-workspace.types.js';
import type {
  ExecutionSessionRepository,
  ExecutionSessionService,
} from './execution-session.types.js';
import type {
  ExternalToolObservationInput,
  ToolInvocationInput,
  ToolInvocationRecord,
  ToolInvocationStatus,
  ToolPolicyConstraints,
  ToolPolicyDecision,
  ToolPolicyGate,
  ToolResult,
  ToolRuntime,
} from './tool-runtime.types.js';
import { ToolRuntimeError } from './tool-runtime.types.js';

export interface DefaultToolRuntimeDeps {
  readonly sessionService: Pick<ExecutionSessionService, 'getSessionForExecution' | 'ensureSession'>;
  readonly sessionRepository: Pick<
    ExecutionSessionRepository,
    'claimToolInvocation' | 'appendToolObservation' | 'listEvents'
  >;
  /** The WORK-035 workspace abstraction (consumed, never duplicated). */
  readonly workspaceRepository: Pick<AgentWorkspaceRepository, 'getWorkspaceForExecution'>;
  /** The SAME materializer the workspace service uses (host-path re-resolution). */
  readonly materializer: WorktreeMaterializer;
  /** One executor per family (injected at the composition root). */
  readonly executors: Readonly<Partial<Record<ToolFamily, ToolExecutor>>>;
  /** The WORK-037 enforcement seam (default: allow). */
  readonly policyGate: ToolPolicyGate;
  readonly auditWriter?: Pick<AuditEventWriter, 'write'>;
  readonly logger: Logger;
  readonly limits?: ToolExecutionLimits;
}

const INVOCATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class DefaultToolRuntime implements ToolRuntime {
  private readonly limits: ToolExecutionLimits;
  /** Same-instance in-flight dedupe (cross-process: the durable claim). */
  private readonly inFlight = new Map<string, Promise<ToolResult>>();

  constructor(private readonly deps: DefaultToolRuntimeDeps) {
    this.limits = deps.limits ?? DEFAULT_TOOL_EXECUTION_LIMITS;
  }

  // ------------------------------------------------------------------ invoke

  async invoke(input: ToolInvocationInput): Promise<ToolResult> {
    this.validateInvocation(input);
    const key = `${input.executionId}:${input.invocationId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.invokeUnchecked(input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async invokeUnchecked(input: ToolInvocationInput): Promise<ToolResult> {
    const session = await this.deps.sessionService.getSessionForExecution(input.executionId);
    if (!session) {
      throw new ToolRuntimeError(
        'tool-runtime-session-not-found',
        `tool-runtime-session-not-found: execution ${input.executionId} has no session — a tool invocation requires the ExecutionSession → Workspace chain`,
        { executionId: input.executionId, invocationId: input.invocationId },
      );
    }
    if (session.status !== 'running') {
      throw new ToolRuntimeError(
        'tool-runtime-session-not-running',
        `tool-runtime-session-not-running: session ${session.id} is '${session.status}' — tools execute only during a RUNNING turn`,
        { sessionId: session.id, status: session.status },
      );
    }

    const workspace = await this.deps.workspaceRepository.getWorkspaceForExecution(input.executionId);
    if (!workspace) {
      throw new ToolRuntimeError(
        'tool-runtime-workspace-not-found',
        `tool-runtime-workspace-not-found: execution ${input.executionId} has no workspace — tools execute inside the WORK-035 workspace environment`,
        { executionId: input.executionId, invocationId: input.invocationId },
      );
    }
    if (workspace.state !== 'ready') {
      throw new ToolRuntimeError(
        'tool-runtime-workspace-not-ready',
        `tool-runtime-workspace-not-ready: workspace ${workspace.id} is '${workspace.state}' — tools execute only in a READY worktree`,
        { workspaceId: workspace.id, state: workspace.state },
      );
    }

    // The workspace host path — the materializer's idempotent
    // re-resolution (the deterministic path is THE workspace worktree).
    let workspaceRoot: string;
    try {
      workspaceRoot = await this.deps.materializer.materialize({
        worktreePathToken: workspace.worktreePath,
        repositoryOwner: workspace.repositoryOwner,
        repositoryName: workspace.repositoryName,
        branch: workspace.branch,
        baseRevision: workspace.baseRevision,
      });
    } catch (err) {
      throw new ToolRuntimeError(
        'tool-runtime-workspace-path-unresolvable',
        `tool-runtime-workspace-path-unresolvable: the workspace ${workspace.id} worktree host path could not be resolved (${(err as Error).message})`,
        { workspaceId: workspace.id },
      );
    }

    // Replay: a completed observation for this invocation key is the
    // idempotent no-duplicate-effect contract.
    const prior = await this.findObservation(session.id, input.invocationId);
    if (prior) return { record: prior, replayed: true };

    // The durable claim (cross-process exactly-one-claimant).
    const startedAt = new Date().toISOString();
    const operation = deriveOperation(input.family, input.input);
    const claim = await this.deps.sessionRepository.claimToolInvocation(session.id, input.invocationId, {
      executionId: input.executionId,
      workspaceId: workspace.id,
      origin: 'native',
      tool: { family: input.family, operation },
      idempotency: input.idempotency,
      status: 'requested',
      startedAt,
    });
    if (!claim.claimed) {
      const existing = claim.existing;
      if (existing.eventType === 'observation') {
        return { record: recordFromPayload(existing.payload), replayed: true };
      }
      // A dangling tool_call marker: a prior attempt's outcome is unknown.
      if (input.idempotency === 'non-idempotent') {
        const unknown: ToolInvocationRecord = {
          invocationId: input.invocationId,
          executionId: input.executionId,
          sessionId: session.id,
          workspaceId: workspace.id,
          origin: 'native',
          tool: { family: input.family, operation },
          input: this.redactedInput(input),
          policy: null,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'unknown',
          exitCode: null,
          stdout: '',
          stderr: '',
          output: null,
          error: {
            code: 'tool-runtime-unknown-outcome',
            message:
              'a prior attempt of this non-idempotent invocation never completed (crash/interruption before the observation landed) — the outcome is UNKNOWN; escalate with a new invocationId to re-run',
          },
          truncated: false,
        };
        const appended = await this.deps.sessionRepository.appendToolObservation(
          session.id,
          input.invocationId,
          { record: unknown },
        );
        if (!appended.appended) {
          return { record: recordFromPayload(appended.existing.payload), replayed: true };
        }
        await this.emitAudit(unknown, session.projectId);
        return { record: unknown, replayed: false };
      }
      // Idempotent: the prior attempt's unknown outcome is HARMLESS to
      // reproduce — re-run safely (the claim marker stays; the new
      // observation completes it).
    }

    // The policy seam — every invocation crosses it BEFORE any executor.
    const redactedInput = this.redactedInput(input);
    const decision = await this.deps.policyGate.decide({
      invocationId: input.invocationId,
      executionId: input.executionId,
      sessionId: session.id,
      workspaceId: workspace.id,
      family: input.family,
      operation,
      input: redactedInput,
    });

    if (decision.decision === 'deny' || decision.decision === 'ask') {
      const blocked = this.buildRecord(input, session.id, workspace.id, operation, redactedInput, {
        decision,
        startedAt,
        status: 'blocked',
        exitCode: null,
        stdout: '',
        stderr: '',
        output: null,
        error: {
          code: `policy-${decision.decision}`,
          message:
            decision.reason ??
            (decision.decision === 'deny'
              ? 'the tool policy gate denied this invocation'
              : 'the tool policy gate requires approval (ask) — not executable without it'),
        },
        truncated: false,
      });
      const appended = await this.deps.sessionRepository.appendToolObservation(session.id, input.invocationId, {
        record: blocked,
      });
      if (!appended.appended) {
        return { record: recordFromPayload(appended.existing.payload), replayed: true };
      }
      await this.emitAudit(blocked, session.projectId);
      return { record: blocked, replayed: false };
    }

    const constraints = decision.decision === 'constrained' ? decision.constraints ?? {} : {};
    if (constraints.readOnly && this.isMutating(input.family, input.input)) {
      const blocked = this.buildRecord(input, session.id, workspace.id, operation, redactedInput, {
        decision,
        startedAt,
        status: 'blocked',
        exitCode: null,
        stdout: '',
        stderr: '',
        output: null,
        error: {
          code: 'policy-constrained-read-only',
          message: 'the policy gate constrained this invocation to read-only operations',
        },
        truncated: false,
      });
      const appended = await this.deps.sessionRepository.appendToolObservation(session.id, input.invocationId, {
        record: blocked,
      });
      if (!appended.appended) {
        return { record: recordFromPayload(appended.existing.payload), replayed: true };
      }
      await this.emitAudit(blocked, session.projectId);
      return { record: blocked, replayed: false };
    }

    // Execute through the family executor (workspace-confined).
    const executor = this.deps.executors[input.family];
    if (!executor) {
      throw new ToolRuntimeError(
        'tool-runtime-unsupported-family',
        `tool-runtime-unsupported-family: no executor is wired for the '${input.family}' family`,
        { family: input.family, invocationId: input.invocationId },
      );
    }
    const ctx: ToolExecutorContext = {
      workspaceRoot,
      signal: input.signal,
      limits: applyConstraints(this.limits, constraints),
    };
    let outcome: ToolExecutionOutcome;
    try {
      outcome = await executor.execute(input.input, ctx);
    } catch (err) {
      // Executors return governed outcomes; a thrown error here is an
      // executor bug — still never a false success.
      outcome = {
        exitCode: null,
        stdout: '',
        stderr: '',
        output: null,
        error: { code: 'executor-internal-error', message: (err as Error).message ?? String(err) },
        cancelled: false,
        truncated: false,
      };
    }

    const status: ToolInvocationStatus = outcome.cancelled
      ? 'cancelled'
      : outcome.error
        ? 'failed'
        : 'succeeded';
    const record = this.buildRecord(input, session.id, workspace.id, operation, redactedInput, {
      decision,
      startedAt,
      status,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      output: redactOutput(input.family, outcome.output),
      error: outcome.error,
      truncated: outcome.truncated,
    });

    try {
      const appended = await this.deps.sessionRepository.appendToolObservation(session.id, input.invocationId, {
        record,
      });
      if (!appended.appended) {
        return { record: recordFromPayload(appended.existing.payload), replayed: true };
      }
    } catch (err) {
      // The tool RAN but the durable observation could not land (e.g. the
      // session terminalized mid-flight). NEVER report unobserved success.
      throw new ToolRuntimeError(
        'tool-runtime-observation-write-failed',
        `tool-runtime-observation-write-failed: the invocation executed (${status}) but its observation could not be persisted (${(err as Error).message}) — the outcome is preserved in the error context`,
        { invocationId: input.invocationId, executionId: input.executionId, status, outcome: record },
      );
    }
    await this.emitAudit(record, session.projectId);
    return { record, replayed: false };
  }

  // ------------------------------------------------- external observations

  async recordExternalObservation(input: ExternalToolObservationInput): Promise<ToolResult> {
    this.validateExternalObservation(input);
    let session;
    try {
      session = await this.deps.sessionService.ensureSession(input.executionId);
    } catch (err) {
      throw new ToolRuntimeError(
        'tool-runtime-session-not-found',
        `tool-runtime-session-not-found: execution ${input.executionId} could not be resolved for an external observation (${(err as Error).message})`,
        { executionId: input.executionId, invocationId: input.invocationId },
      );
    }
    const record: ToolInvocationRecord = {
      invocationId: input.invocationId,
      executionId: input.executionId,
      sessionId: session.id,
      workspaceId: null, // the provider-native environment — NOT a WorkflowOS workspace
      origin: 'external',
      tool: { family: input.family, operation: input.operation },
      input: {},
      policy: null, // the provider's policy context is out of WorkflowOS scope
      startedAt: input.startedAt ?? input.completedAt,
      completedAt: input.completedAt,
      status: input.status,
      exitCode: input.exitCode ?? null,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      output: redactOutput(input.family, input.output ?? null),
      error: input.error ?? null,
      truncated: input.truncated ?? false,
    };
    const appended = await this.deps.sessionRepository.appendToolObservation(session.id, input.invocationId, {
      record,
      source: input.source ?? 'external',
    });
    if (!appended.appended) {
      return { record: recordFromPayload(appended.existing.payload), replayed: true };
    }
    await this.emitAudit(record, session.projectId);
    return { record, replayed: false };
  }

  // ----------------------------------------------------------------- helpers

  private validateInvocation(input: ToolInvocationInput): void {
    if (!input || typeof input.invocationId !== 'string' || !INVOCATION_ID_PATTERN.test(input.invocationId)) {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: invocationId must match [A-Za-z0-9._:-]{1,128}',
        { invocationId: input?.invocationId },
      );
    }
    if (typeof input.executionId !== 'string' || input.executionId.length === 0) {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: executionId is required',
        { invocationId: input?.invocationId },
      );
    }
    if (!input || typeof input.family !== 'string') {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: family is required',
        { invocationId: input?.invocationId },
      );
    }
    if (input.idempotency !== 'idempotent' && input.idempotency !== 'non-idempotent') {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        "tool-runtime-invalid-input: idempotency must be 'idempotent' | 'non-idempotent'",
        { invocationId: input.invocationId },
      );
    }
    if (!input.input || typeof input.input !== 'object') {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: the family input object is required',
        { invocationId: input.invocationId, family: input.family },
      );
    }
    // Family SHAPE validation (the invocation contract) — a malformed
    // input never even CLAIMS a durable invocation key. The executors
    // re-validate defensively (governed outcomes).
    const inv = input.invocationId;
    const shapeError = validateFamilyShape(input.family, input.input);
    if (shapeError) {
      throw new ToolRuntimeError('tool-runtime-invalid-input', `tool-runtime-invalid-input: ${shapeError}`, {
        invocationId: inv,
        family: input.family,
      });
    }
  }

  private validateExternalObservation(input: ExternalToolObservationInput): void {
    if (!input || typeof input.invocationId !== 'string' || !INVOCATION_ID_PATTERN.test(input.invocationId)) {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: invocationId must match [A-Za-z0-9._:-]{1,128}',
        { invocationId: input?.invocationId },
      );
    }
    if (typeof input.executionId !== 'string' || input.executionId.length === 0) {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        'tool-runtime-invalid-input: executionId is required',
        { invocationId: input?.invocationId },
      );
    }
    const statuses: ToolInvocationStatus[] = ['succeeded', 'failed', 'cancelled', 'blocked', 'unknown'];
    if (!statuses.includes(input.status)) {
      throw new ToolRuntimeError(
        'tool-runtime-invalid-input',
        `tool-runtime-invalid-input: status must be one of ${statuses.join('|')}`,
        { invocationId: input.invocationId, status: input.status },
      );
    }
  }

  /** The completed observation for an invocation key, if any. */
  private async findObservation(
    sessionId: string,
    invocationId: string,
  ): Promise<ToolInvocationRecord | null> {
    const events = await this.deps.sessionRepository.listEvents(sessionId);
    const obs = events.find(
      (e) => e.eventType === 'observation' && e.payload?.invocationId === invocationId,
    );
    return obs ? recordFromPayload(obs.payload) : null;
  }

  private redactedInput(input: ToolInvocationInput): Record<string, unknown> {
    const redacted = redactForObservation(input.input) as Record<string, unknown>;
    if (input.family === 'http' && redacted && typeof redacted.headers === 'object' && redacted.headers) {
      redacted.headers = redactHttpHeaders(redacted.headers as Record<string, string>);
    }
    return redacted ?? {};
  }

  private buildRecord(
    input: ToolInvocationInput,
    sessionId: string,
    workspaceId: string,
    operation: string,
    redactedInput: Record<string, unknown>,
    fields: {
      decision: ToolPolicyDecision;
      startedAt: string;
      status: ToolInvocationStatus;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      output: Record<string, unknown> | null;
      error: { code: string; message: string } | null;
      truncated: boolean;
    },
  ): ToolInvocationRecord {
    return {
      invocationId: input.invocationId,
      executionId: input.executionId,
      sessionId,
      workspaceId,
      origin: 'native',
      tool: { family: input.family, operation },
      input: redactedInput,
      policy: { decision: fields.decision.decision, reason: fields.decision.reason },
      startedAt: fields.startedAt,
      completedAt: new Date().toISOString(),
      status: fields.status,
      exitCode: fields.exitCode,
      stdout: fields.stdout,
      stderr: fields.stderr,
      output: fields.output,
      error: fields.error,
      truncated: fields.truncated,
    };
  }

  /** Audit emission is supplementary (never rolls back an invocation). */
  private async emitAudit(record: ToolInvocationRecord, projectId?: string): Promise<void> {
    if (!this.deps.auditWriter) return;
    try {
      await this.deps.auditWriter.write({
        eventType: `tool.invocation.${record.status}`,
        actor: 'tool-runtime',
        source: 'agents/tool-runtime',
        resourceType: 'tool_invocation',
        resourceId: record.invocationId,
        projectId: projectId ?? null,
        executionId: record.executionId,
        metadata: {
          sessionId: record.sessionId,
          workspaceId: record.workspaceId,
          origin: record.origin,
          family: record.tool.family,
          operation: record.tool.operation,
          status: record.status,
          exitCode: record.exitCode,
          errorCode: record.error?.code ?? null,
          truncated: record.truncated,
        },
      });
    } catch (err) {
      this.deps.logger.warn('tool-runtime.audit-write-failed', {
        invocationId: record.invocationId,
        error: (err as Error).message,
      });
    }
  }

  /** Whether a family/input combination mutates state (read-only constraint). */
  private isMutating(family: ToolFamily, input: ToolFamilyRequest): boolean {
    switch (family) {
      case 'filesystem':
        return !['read', 'list', 'stat'].includes((input as FilesystemToolRequest).operation);
      case 'http':
        return (input as HttpToolRequest).method !== 'GET' && (input as HttpToolRequest).method !== 'HEAD';
      case 'browser':
        return ['click', 'type'].includes((input as BrowserToolRequest).operation);
      case 'terminal':
      case 'git':
      case 'package':
        return true; // process execution is inherently mutating-capable
    }
  }
}

/** The per-family input shape contract (the runtime's pre-claim validation). */
function validateFamilyShape(family: ToolFamily, input: ToolFamilyRequest): string | null {
  const isStringArray = (a: unknown): a is readonly string[] =>
    Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string');
  switch (family) {
    case 'filesystem': {
      const req = input as FilesystemToolRequest;
      if (typeof req.operation !== 'string' || !['read', 'write', 'list', 'stat', 'mkdir', 'delete'].includes(req.operation)) {
        return 'filesystem input requires operation ∈ read|write|list|stat|mkdir|delete';
      }
      if (typeof req.path !== 'string' || req.path.length === 0) return 'filesystem input requires a non-empty path';
      if (req.operation === 'write' && typeof req.content !== 'string') return 'filesystem write requires content';
      return null;
    }
    case 'terminal': {
      const req = input as TerminalToolRequest;
      if (!isStringArray(req.argv)) return 'terminal input requires a non-empty argv of strings';
      return null;
    }
    case 'git': {
      const req = input as GitToolRequest;
      if (!isStringArray(req.args)) return 'git input requires a non-empty args array of strings';
      return null;
    }
    case 'package': {
      const req = input as PackageToolRequest;
      if (typeof req.runner !== 'string' || req.runner.length === 0) return 'package input requires a runner name';
      if (!Array.isArray(req.args) || !req.args.every((x) => typeof x === 'string')) {
        return 'package input requires an args array of strings';
      }
      return null;
    }
    case 'http': {
      const req = input as HttpToolRequest;
      if (typeof req.url !== 'string' || req.url.length === 0) return 'http input requires a url';
      if (typeof req.method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return 'http input requires a governed method';
      }
      return null;
    }
    case 'browser': {
      const req = input as BrowserToolRequest;
      if (typeof req.operation !== 'string' || !['open', 'click', 'type', 'extract', 'screenshot'].includes(req.operation)) {
        return 'browser input requires operation ∈ open|click|type|extract|screenshot';
      }
      if (req.operation === 'open' && (typeof req.url !== 'string' || req.url.length === 0)) return 'browser open requires a url';
      if ((req.operation === 'click' || req.operation === 'type' || req.operation === 'extract') && typeof req.selector !== 'string') {
        return `browser ${req.operation} requires a selector`;
      }
      if (req.operation === 'type' && typeof req.text !== 'string') return 'browser type requires text';
      return null;
    }
  }
}

/** Derive the durable operation label from the family input. */
function deriveOperation(family: ToolFamily, input: ToolFamilyRequest): string {
  switch (family) {
    case 'filesystem':
      return `fs.${(input as FilesystemToolRequest).operation ?? 'unknown'}`;
    case 'terminal':
      return 'terminal.exec';
    case 'git':
      return `git.${(input as GitToolRequest).args?.[0] ?? 'unknown'}`;
    case 'package':
      return `package.${(input as PackageToolRequest).runner ?? 'unknown'}`;
    case 'http':
      return `http.${(input as HttpToolRequest).method ?? 'unknown'}`;
    case 'browser':
      return `browser.${(input as BrowserToolRequest).operation ?? 'unknown'}`;
  }
}

/** Redact family outputs that carry credential-shaped values. */
function redactOutput(
  family: ToolFamily,
  output: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!output) return null;
  const redacted = redactForObservation(output) as Record<string, unknown>;
  if (family === 'http' && redacted && typeof redacted.headers === 'object' && redacted.headers) {
    redacted.headers = redactHttpHeaders(redacted.headers as Record<string, string>);
  }
  return redacted;
}

/** Apply policy constraints over the structural limits (tighten only). */
function applyConstraints(base: ToolExecutionLimits, c: ToolPolicyConstraints): ToolExecutionLimits {
  if (!c || Object.keys(c).length === 0) return base;
  return {
    ...base,
    defaultTimeoutMs: c.timeoutMs ? Math.min(base.defaultTimeoutMs, c.timeoutMs) : base.defaultTimeoutMs,
    maxTimeoutMs: c.timeoutMs ? Math.min(base.maxTimeoutMs, c.timeoutMs) : base.maxTimeoutMs,
    maxOutputBytes: c.maxOutputBytes ? Math.min(base.maxOutputBytes, c.maxOutputBytes) : base.maxOutputBytes,
    maxHttpBodyBytes: c.maxOutputBytes ? Math.min(base.maxHttpBodyBytes, c.maxOutputBytes) : base.maxHttpBodyBytes,
  };
}

/** Reconstruct a record from a stored observation payload. */
function recordFromPayload(payload: Record<string, unknown>): ToolInvocationRecord {
  const record = (payload?.record ?? payload) as ToolInvocationRecord;
  if (!record || typeof record !== 'object' || typeof record.invocationId !== 'string') {
    throw new ToolRuntimeError(
      'tool-runtime-observation-write-failed',
      'tool-runtime-observation-write-failed: a stored observation payload is malformed',
      { payload },
    );
  }
  return record;
}
