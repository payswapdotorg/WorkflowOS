/**
 * WORK-036: the Tool Runtime contracts inside /agents — the governed
 * boundary BENEATH the execution/session/workspace authority:
 *
 *     Work Item → Work Order → ExecutionRecord → ExecutionSession
 *              → Workspace (WORK-035) → TOOL RUNTIME → actual tool
 *
 * The tool runtime is EXECUTION INFRASTRUCTURE (spec §33.8): it consumes
 * the WORK-035 workspace abstraction (never a competing filesystem/
 * worktree system), dispatches governed tool families through the
 * platform executor ports, and records every outcome through the
 * EXISTING evidence architecture (ExecutionSession `tool_call` +
 * `observation` events — the frozen WORK-034 vocabulary — plus the audit
 * boundary). It is NOT an authority: no tool outcome mutates workflow,
 * verification, review, merge, or architecture state; it creates no
 * execution engine, no provider registry, no permission engine (that is
 * WORK-037), no scheduler.
 *
 * THE NORMALIZED CONTRACT (every invocation, native OR external):
 *   tool identity (family + operation) · invocation identity (the
 *   caller-supplied invocationId idempotency key) · execution/session/
 *   workspace identity · input (redacted) · the policy decision boundary
 *   · start + completion time · success/failure · structured output ·
 *   stderr/error · exit status · cancellation/interruption.
 *
 * CRASH SAFETY / IDEMPOTENCY (the explicit reasoning the boundary owes):
 *   * "tool requested → crash → retry": the invocationId is the durable
 *     idempotency key. A completed observation replays (no duplicate
 *     logical effect). A dangling request marker (crash before
 *     completion) with `idempotency: 'idempotent'` re-runs safely; with
 *     `idempotency: 'non-idempotent'` the retry reports the typed
 *     'unknown' status — UNCERTAINTY MADE OBSERVABLE, never a false
 *     success.
 *   * "tool running → interruption → resume": caller cancellation
 *     (AbortSignal) kills the process/aborts the request; the outcome is
 *     `cancelled` + observed; resumption is a NEW invocation in the
 *     session's turn model (no mid-flight process resurrection).
 *   * The invocation-key claim + the observation append are BOTH
 *     transactional under the session row lock (the existing CAS /
 *     transactional patterns — no race-prone mutable global state).
 *
 * NATIVE / EXTERNAL PARITY:
 *   * native: ExecutionSession → Workspace → governed ToolRuntime.invoke.
 *   * external: the provider-native environment runs its own tools and
 *     reports observations through recordExternalObservation() — the
 *     SAME normalized contract, appended to the same session evidence
 *     log, with NO authority to execute anything on the WorkflowOS host
 *     and NO authority to mutate WorkflowOS state.
 */
import type { ToolFamily, ToolFamilyRequest } from '@platform/tools/tool-contracts.js';

// The platform tool contracts re-exported through the /agents barrel (the
// WORK-035 worktree-materializer pattern: domain → platform dependency
// direction; concrete executors stay internal to the composition root).
export type {
  ToolFamily,
  ToolFamilyRequest,
  ToolExecutionLimits,
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutionOutcome,
  FilesystemToolRequest,
  FilesystemToolOperation,
  TerminalToolRequest,
  GitToolRequest,
  PackageToolRequest,
  HttpToolRequest,
  HttpToolMethod,
  BrowserToolRequest,
  BrowserToolOperation,
} from '@platform/tools/tool-contracts.js';
export { DEFAULT_TOOL_EXECUTION_LIMITS } from '@platform/tools/tool-contracts.js';

// ============================================================================
// §policy-seam — the WORK-037 enforcement seam (NOT the permission engine)
// ============================================================================

/**
 * The policy decision vocabulary WORK-037 will govern. WORK-036 ships
 * only the SEAM: every invocation passes through the gate before any
 * executor runs, and the decision is part of the durable record.
 *
 *   allow       — execute.
 *   deny        — refuse; the invocation is observed as 'blocked'.
 *   ask         — not executable without human approval (WORK-037 will
 *                 implement the interaction); observed as 'blocked'.
 *   constrained — execute under the declared constraints (a tighter
 *                 timeout, output bound, or read-only mode).
 */
export type ToolPolicyDecisionValue = 'allow' | 'deny' | 'ask' | 'constrained';

/** The constraints a 'constrained' decision may impose (structural only). */
export interface ToolPolicyConstraints {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Read-only mode: mutating families/operations are refused (blocked). */
  readonly readOnly?: boolean;
}

export interface ToolPolicyDecision {
  readonly decision: ToolPolicyDecisionValue;
  readonly reason?: string;
  readonly constraints?: ToolPolicyConstraints;
}

/** What the gate may inspect (the REDACTED input — never raw secrets). */
export interface ToolPolicyRequest {
  /** The invocation identity (stable policy decisions per invocation key). */
  readonly invocationId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly family: ToolFamily;
  readonly operation: string;
  /** The invocation input, already redacted for observation. */
  readonly input: Record<string, unknown>;
}

/** The enforcement seam: ONE decision point every invocation must cross. */
export interface ToolPolicyGate {
  decide(request: ToolPolicyRequest): Promise<ToolPolicyDecision>;
}

/**
 * The WORK-036 default gate: ALLOW (there is no permission engine yet —
 * WORK-037 supplies the policy). The seam, the decision record, and the
 * refusal semantics (deny/ask → 'blocked', constrained → tightened
 * limits / read-only) are all live; only the DECIDING is permissive.
 */
export class DefaultToolPolicyGate implements ToolPolicyGate {
  async decide(): Promise<ToolPolicyDecision> {
    return { decision: 'allow' };
  }
}

// ============================================================================
// §normalized-record — the provider-independent invocation contract
// ============================================================================

/** Caller-declared retry semantics (drives the crash/retry contract). */
export type ToolInvocationIdempotency = 'idempotent' | 'non-idempotent';

/** The terminal invocation statuses (uncertainty is observable). */
export type ToolInvocationStatus = 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'unknown';

/** The observed tool identity (family + the derived operation label). */
export interface ToolIdentity {
  readonly family: ToolFamily;
  readonly operation: string;
}

/**
 * The normalized invocation record — what native invocations produce,
 * what external providers report, and what the durable observation
 * stores. Timestamps are ISO strings (JSON-safe for the event payload).
 */
export interface ToolInvocationRecord {
  /** The caller-supplied idempotency key (the invocation identity). */
  readonly invocationId: string;
  readonly executionId: string;
  readonly sessionId: string;
  /** The WORK-035 workspace (null for external provider-side observations). */
  readonly workspaceId: string | null;
  readonly origin: 'native' | 'external';
  readonly tool: ToolIdentity;
  /** The redacted invocation input. */
  readonly input: Record<string, unknown>;
  /** The policy decision boundary (null for external observations). */
  readonly policy: { readonly decision: ToolPolicyDecisionValue; readonly reason?: string } | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: ToolInvocationStatus;
  /** The process exit code where applicable. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The family-specific structured output (redacted). */
  readonly output: Record<string, unknown> | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly truncated: boolean;
}

/** The invoke() result: the record + whether it was an idempotent replay. */
export interface ToolResult {
  readonly record: ToolInvocationRecord;
  readonly replayed: boolean;
}

// ============================================================================
// §inputs
// ============================================================================

/** A governed NATIVE invocation (executes inside the workspace). */
export interface ToolInvocationInput {
  /**
   * The invocation identity / idempotency key: non-empty, ≤ 128 chars,
   * [A-Za-z0-9._:-] (it is matched against durable event payloads — it
   * must be a stable, injectable key).
   */
  readonly invocationId: string;
  /** The LOGICAL execution identity (the TEXT executionId). */
  readonly executionId: string;
  readonly family: ToolFamily;
  readonly input: ToolFamilyRequest;
  readonly idempotency: ToolInvocationIdempotency;
  /** Caller cancellation (interruption): kills/aborts the in-flight tool. */
  readonly signal?: AbortSignal;
}

/**
 * A provider-side tool observation (external execution parity): the SAME
 * normalized record shape, appended to the session evidence log. This
 * boundary NEVER executes anything and NEVER mutates WorkflowOS state —
 * it observes. Requires no workspace (the provider-native environment
 * ran the tool).
 */
export interface ExternalToolObservationInput {
  readonly invocationId: string;
  readonly executionId: string;
  readonly family: ToolFamily;
  readonly operation: string;
  readonly startedAt?: string;
  readonly completedAt: string;
  readonly status: ToolInvocationStatus;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly output?: Record<string, unknown> | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly truncated?: boolean;
  /** The provider-side source label (e.g. 'companion:external-provider'). */
  readonly source?: string;
}

// ============================================================================
// §runtime-port
// ============================================================================

/**
 * The governed tool runtime boundary. invoke() is the ONLY native
 * execution path for tools; recordExternalObservation() is the ONLY
 * external observation path. Neither is an authority.
 */
export interface ToolRuntime {
  invoke(input: ToolInvocationInput): Promise<ToolResult>;
  recordExternalObservation(input: ExternalToolObservationInput): Promise<ToolResult>;
}

// ============================================================================
// §typed-errors — the tool-runtime error hierarchy (the WORK-034/035
// discriminated-class pattern: stable codes + structured context)
// ============================================================================

export const TOOL_RUNTIME_ERROR_CODES = [
  'tool-runtime-invalid-input',
  'tool-runtime-unsupported-family',
  'tool-runtime-session-not-found',
  'tool-runtime-session-not-running',
  'tool-runtime-workspace-not-found',
  'tool-runtime-workspace-not-ready',
  'tool-runtime-workspace-path-unresolvable',
  'tool-runtime-observation-write-failed',
] as const;

export type ToolRuntimeErrorCode = (typeof TOOL_RUNTIME_ERROR_CODES)[number];

export class ToolRuntimeError extends Error {
  readonly code: ToolRuntimeErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ToolRuntimeErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
    this.code = code;
    this.context = context;
  }
}
