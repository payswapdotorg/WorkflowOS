/**
 * WORK-027: Execution provider abstraction — public contract types.
 *
 * WorkflowOS supports two ways to execute the same Work Order:
 *
 *   NATIVE:    WorkflowOS → provider API → agent/model → GitHub → CI →
 *              Verification → Architect Review.
 *   EXTERNAL:  WorkflowOS → external execution package → WorkflowOS Companion
 *              extension → ChatGPT / Claude / Z.ai native UI → GitHub → CI →
 *              Verification → Architect Review.
 *
 * Both modes use the SAME authoritative WorkflowOS objects (Project,
 * Architecture, Requirements, Criteria, Work Item, Work Order,
 * ImplementationContext, PR/CI evidence, Verification, Review, Audit). The
 * execution mode is an implementation detail behind the ExecutionProvider
 * boundary.
 *
 * Authority rules (NON-NEGOTIABLE):
 *   - The canonical Work Item workflow state machine remains owned by
 *     /workflows. Execution state (below) is a SEPARATE state machine that
 *     describes only the execution record itself.
 *   - Verification semantics remain owned by /verification; reviews by
 *     /reviews; PR/merge authority remains the GitHub webhook. An external
 *     execution can REPORT commit/branch/PR/test summaries, but it can never
 *     declare MERGED / VERIFIED / PASS / APPROVED.
 *   - ExternalExecutionPackage contains NO secrets of any kind (no GitHub
 *     tokens, no LLM API keys, no Vercel tokens, no webhook secrets).
 *
 * This file is private to /agents (PLAT-AC-02). The barrel exports the types
 * below; concrete implementations stay in internal/.
 */

/** How the Work Order is executed. */
export type ExecutionMode = 'native' | 'external';

/**
 * Execution-level state machine (WORK-027 §8). These states belong to
 * EXECUTION RECORDS ONLY — they are NOT Work Item workflow states and must
 * never be written to wfos_workflow_executions.
 *
 *   created        — record created, not yet dispatched
 *   queued         — accepted for asynchronous dispatch (reserved)
 *   running        — a provider (native or external session) is executing
 *   handoff_ready  — external package generated, awaiting handoff
 *   submitted      — package handed off to the external session (token redeemed)
 *   completed      — provider reported completion
 *   failed         — provider reported (or suffered) failure
 *   cancelled      — cancelled by an operator (reserved)
 *   expired        — external handoff window elapsed without completion
 */
export type ExecutionState =
  | 'created'
  | 'queued'
  | 'running'
  | 'handoff_ready'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * Provider-independent description of one Work Order execution.
 *
 * Constructed exclusively from authoritative, persisted WorkflowOS data by
 * the ExecutionTaskService (owned by /work-items — the ImplementationContext
 * authority). Providers never reconstruct the Work Order themselves.
 */
export interface ExecutionTask {
  /** Traceable WorkflowOS execution id (generateExecutionId(), `wf_xxxxxxxx`). */
  readonly executionId: string;
  readonly mode: ExecutionMode;
  /** Agent provider name (e.g. 'fake', 'openai', 'zai', 'chatgpt', 'claude'). */
  readonly provider: string;
  /** Model (required for native execution; optional for external). */
  readonly model: string | null;
  readonly projectId: string;
  /** Work Item UUID. */
  readonly workItemId: string;
  /** Human Work Item label (e.g. 'WORK-001') — used in prompts + packages. */
  readonly workItemLabel: string;
  readonly workOrderId: string;
  readonly architectureVersionId: string | null;
  readonly implementationContextId: string;
  readonly implementationContextRevision: number;
  readonly implementationContextKind: 'initial' | 'correction';
  readonly repositoryOwner: string | null;
  readonly repositoryName: string | null;
  readonly repositoryDefaultBranch: string | null;
  /** Authoritative implementation branch when known; null = agent derives it. */
  readonly implementationBranch: string | null;
  /** Work Item scope (from the ImplementationContext). */
  readonly scope: string | null;
  /** Expected test outputs (from acceptance criteria verification expectations). */
  readonly expectedOutputs: readonly string[];
  readonly verificationRequirements: readonly string[];
  readonly architectureConstraints: string | null;
  /** Deterministic implementation prompt markdown (built by WorkflowOS). */
  readonly prompt: string;
  /** SHA-256 hex digest of `prompt` (determinism proof + benchmark key). */
  readonly promptDigest: string;
  /**
   * JSON serialization of the persisted ImplementationContextContent. Native
   * providers pass this to the AgentGateway as the agent input — byte-for-byte
   * identical to the pre-WORK-027 start-implementation behavior.
   */
  readonly contextPayload: string;
  /** Structured agent instructions (DEFAULT_AGENT_INSTRUCTIONS). */
  readonly instructions: readonly string[];
  /**
   * PR #46 round 7 (the provider-operation exactly-once boundary): the
   * DURABLE idempotency key for THIS provider dispatch — derived from the
   * LOGICAL HANDOFF IDENTITY (`cross-mode-dispatch-<handoffId>`), NEVER from
   * the volatile lease owner/epoch, so every actor that dispatches the same
   * logical handoff (the original owner, a reclaiming owner, a crash-recovery
   * re-dispatch) derives the SAME key.
   *
   * THE PROVIDER CONTRACT (the architect's round-7 option 1 — the exactly-once
   * side-effect boundary): when a task carries this key, `submit()` MUST NOT
   * start a SECOND provider operation for the same key — a same-key submit
   * CONVERGES to the operation the first submit already started (it returns
   * that operation's submission — awaiting it when still in flight — exactly
   * like a Stripe-style `Idempotency-Key`). The correctness of a keyed
   * dispatch may never depend on provider determinism/purity: the provider
   * must return the REGISTERED operation, not a re-computed lookalike.
   *
   * PR #46 round 8 (the DURABLE idempotency boundary): the keyed operation
   * registry is DURABLE — it survives provider-instance loss, process loss,
   * and reclaim-driven re-dispatch by any other actor. A same-key submit
   * through a FRESH provider instance resolves to the SAME operation the
   * original instance opened:
   *
   *   - EXTERNAL mode: the durable provider-operation ledger is
   *     `wfos_execution_provider_operations` (migration 0048). The ledger ROW
   *     IS the operation (idempotency_key PRIMARY KEY — ONE row per key);
   *     its states are PENDING / COMPLETED / FAILED + the stored
   *     operation/result (submission_json — replayed by every later same-key
   *     submit). A PENDING row whose driver died is resolved THROUGH THE SAME
   *     ROW by the recovering actor (the await-then-take-over): the single
   *     resolution CAS stores exactly one result, and a dead driver's late
   *     completion affects 0 rows and replays the winner's stored result.
   *
   *   - NATIVE mode: the durable native provider-operation ledger is
   *     `wfos_agent_runs` (migration 0011 — `execution_id TEXT NOT NULL
   *     UNIQUE`). The run row IS the native provider operation (the run
   *     creation + the adapter execution the gateway performs only AFTER its
   *     own run-creation succeeded); the execution_id UNIQUE IS the
   *     operation-key uniqueness (the keyed native dispatch derives its
   *     operation identity from the durable execution identity), and the
   *     run's status/refs ARE the operation result. Process-loss recovery on
   *     the native path is CONVERGE-ON-THE-EXISTING-RUN: a keyed submit whose
   *     run already exists NEVER reaches the gateway (no second run
   *     creation, no second adapter invocation) — around run creation /
   *     adapter invocation, the run row is the durable record whether the
   *     crashed actor's adapter invocation ever ran.
   *
   * Absent/null (the mainline one-shot dispatch): the provider's pre-WORK-042
   * behavior applies unchanged (a direct generation/dispatch, no registry).
   */
  readonly dispatchIdempotencyKey?: string | null;
}

/** What an ExecutionProvider returns after accepting a task. */
export interface ExecutionSubmission {
  readonly executionId: string;
  readonly provider: string;
  readonly mode: ExecutionMode;
  readonly status: ExecutionState;
  /** Native mode: the persisted AgentRun id. */
  readonly agentRunId?: string;
  /** External mode: provider session reference, when one exists. */
  readonly externalSessionRef?: string | null;
  readonly commitRef?: string | null;
  readonly pullRequestRef?: string | null;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  /** External mode: the generated package (stored server-side, token-gated). */
  readonly package?: ExternalExecutionPackage;
  /** External mode: package expiry instant. */
  readonly expiresAt?: Date;
}

/**
 * Provider boundary for Work Order execution. Exactly two implementations
 * exist in WORK-027:
 *
 *   - NativeExecutionProvider (/agents internal) → delegates to the existing
 *     AgentGateway. There is NO second AgentGateway.
 *   - ExternalExecutionProvider (/agents internal) → generates a deterministic
 *     ExternalExecutionPackage and returns 'handoff_ready'. It does NOT
 *     execute anything and contains NO provider-specific (Z.ai/ChatGPT/Claude)
 *     DOM automation or URLs — that belongs to WORK-028/029.
 *
 * PR #46 round 7 (the provider-operation exactly-once boundary): when the
 * submitted {@link ExecutionTask} carries a `dispatchIdempotencyKey`, `submit`
 * is IDEMPOTENT BY THAT KEY — a retried or reclaimed dispatch with the same
 * key MUST CONVERGE to the SAME provider operation (the first submit's
 * operation — its stored submission, awaited when still in flight), NEVER a
 * second independent operation. The cross-mode handoff dispatch ALWAYS keys
 * its submissions (the WORK-042 service derives the key from the handoff
 * identity); the mainline one-shot dispatch is unkeyed (behavior unchanged).
 * A future non-pure provider (WORK-028/029 real external platforms) MUST
 * implement the key through the platform's own idempotency mechanism — the
 * architecture does NOT rely on provider determinism.
 *
 * PR #46 round 8 (the DURABLE idempotency boundary): the keyed operation
 * registry is DURABLE — it lives in PostgreSQL, NOT in provider-instance
 * memory. The same key resolves to the same operation across provider
 * instances, processes, and actors:
 *
 *   - external — the DURABLE PROVIDER-OPERATION LEDGER
 *     (`wfos_execution_provider_operations`, migration 0048): the ROW is the
 *     operation (ONE per key — PRIMARY KEY), PENDING / COMPLETED / FAILED +
 *     the stored result; same key always resolves to the same operation.
 *     An in-process Map registry is FORBIDDEN (it dies with the instance).
 *
 *   - native — `wfos_agent_runs` (migration 0011) IS the durable native
 *     provider-operation ledger: `execution_id` UNIQUE is the operation-key
 *     uniqueness, the run row is the operation + its result, and a keyed
 *     submit whose run exists converges (never a second gateway/adapter
 *     call).
 */
export interface ExecutionProvider {
  readonly name: string;
  readonly mode: ExecutionMode;
  submit(task: ExecutionTask): Promise<ExecutionSubmission>;
}

/**
 * The information a browser extension needs to execute the Work Order in an
 * external AI platform. Generated by WorkflowOS from the persisted
 * ImplementationContext — the extension NEVER reconstructs the Work Order.
 *
 * SECURITY: contains no GitHub tokens, no LLM API keys, no Vercel tokens, no
 * webhook secrets, no WorkflowOS credentials of any kind. The package is
 * retrievable only through the authenticated, short-lived, one-time handoff
 * token mechanism (ExecutionHandoffService).
 */
export interface ExternalExecutionPackage {
  readonly executionId: string;
  readonly mode: 'external';
  readonly projectId: string;
  readonly workItemId: string;
  readonly workItemLabel: string;
  readonly workOrderId: string;
  readonly implementationContextId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly repository: {
    readonly owner: string | null;
    readonly name: string | null;
    readonly url: string | null;
    readonly defaultBranch: string | null;
  };
  /** Branch the external agent should implement on. */
  readonly branch: string;
  /** Deterministic implementation prompt generated by WorkflowOS. */
  readonly prompt: string;
  readonly structuredInstructions: readonly string[];
  readonly verificationRequirements: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly browserTestRequirements: readonly string[];
  /**
   * How the extension reports progress back to WorkflowOS. Ingested events
   * update ONLY the execution record — they can never mutate workflow,
   * verification, or review state.
   */
  readonly returnCallback: {
    readonly eventsPath: string;
    readonly eventTypes: readonly string[];
    /** Credential mechanism: the scoped callback token header (NOT an API key). */
    readonly auth: string;
    readonly note: string;
  };
  /** ISO-8601 instant after which the package is no longer redeemable. */
  readonly expiration: string;
}

/** Persisted execution record (safe view; package fetched via handoff only). */
export interface ExecutionRecord {
  readonly id: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly implementationContextId: string;
  readonly mode: ExecutionMode;
  readonly provider: string;
  readonly model: string | null;
  readonly status: ExecutionState;
  readonly agentRunId: string | null;
  readonly externalSessionRef: string | null;
  readonly repositoryRef: string | null;
  readonly branch: string | null;
  readonly prompt: string;
  readonly promptDigest: string;
  readonly packageValue: ExternalExecutionPackage | null;
  readonly benchmarkMetadata: Record<string, unknown>;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateExecutionRecordInput {
  readonly executionId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly implementationContextId: string;
  readonly mode: ExecutionMode;
  readonly provider: string;
  readonly model?: string | null;
  readonly repositoryRef?: string | null;
  readonly branch?: string | null;
  readonly prompt: string;
  readonly promptDigest: string;
  readonly benchmarkMetadata?: Record<string, unknown>;
}

export interface UpdateExecutionStatusInput {
  readonly status: ExecutionState;
  readonly agentRunId?: string | null;
  readonly externalSessionRef?: string | null;
  readonly packageValue?: ExternalExecutionPackage | null;
  readonly benchmarkMetadata?: Record<string, unknown>;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly expiresAt?: Date | null;
}

/**
 * WORK-042: input for a cross-mode mode transition
 * ({@link ExecutionRecordRepository.transitionMode}). Unlike
 * {@link UpdateExecutionStatusInput}, this ALSO updates the `mode` (and may
 * update `provider`/`model`). Used ONLY by the cross-mode handoff service to
 * transition an existing ExecutionRecord from native <-> external while
 * preserving its identity (the same row). Unspecified fields keep their
 * current value (COALESCE) so a native->external transition can set the
 * package + expires_at without clearing agent_run_id, and an external->native
 * transition can set agent_run_id without clearing package_json.
 *
 * This method does NOT touch workflow/verification/review state, and the
 * handoff log table's UNIQUE(execution_record_id) is the concurrency fence (no
 * CAS on version is needed here — the handoff row is the reserve step).
 */
export interface TransitionModeInput {
  readonly mode: ExecutionMode;
  readonly status: ExecutionState;
  readonly provider?: string;
  readonly model?: string | null;
  readonly packageValue?: ExternalExecutionPackage | null;
  readonly agentRunId?: string | null;
  readonly externalSessionRef?: string | null;
  readonly expiresAt?: Date | null;
  readonly benchmarkMetadata?: Record<string, unknown>;
}

export interface ExecutionRecordRepository {
  create(input: CreateExecutionRecordInput): Promise<ExecutionRecord>;
  findById(id: string): Promise<ExecutionRecord | null>;
  findByExecutionId(executionId: string): Promise<ExecutionRecord | null>;
  listForWorkItem(workItemId: string): Promise<ExecutionRecord[]>;
  updateStatus(id: string, input: UpdateExecutionStatusInput): Promise<ExecutionRecord | null>;
  /**
   * WORK-042: transition an existing execution record's mode + status (+ the
   * mode-specific authoritative fields). The cross-mode handoff log table's
   * UNIQUE(execution_record_id) is the concurrency fence. Returns null when
   * the record does not exist.
   */
  transitionMode(id: string, input: TransitionModeInput): Promise<ExecutionRecord | null>;
}

/** One ingested external execution event (audit trail for the boundary). */
export interface ExecutionEventRecord {
  readonly id: string;
  readonly executionRecordId: string;
  readonly eventType: 'started' | 'progress' | 'completed' | 'failed';
  readonly commitRef: string | null;
  readonly branch: string | null;
  readonly pullRequestRef: string | null;
  readonly testSummary: Record<string, unknown> | null;
  readonly output: string | null;
  readonly externalSessionRef: string | null;
  readonly idempotencyKey: string | null;
  readonly receivedAt: Date;
}

export interface AppendExecutionEventInput {
  readonly executionRecordId: string;
  readonly eventType: 'started' | 'progress' | 'completed' | 'failed';
  readonly commitRef?: string | null;
  readonly branch?: string | null;
  readonly pullRequestRef?: string | null;
  readonly testSummary?: Record<string, unknown> | null;
  readonly output?: string | null;
  readonly externalSessionRef?: string | null;
  readonly idempotencyKey?: string | null;
}

export interface ExecutionEventRepository {
  append(input: AppendExecutionEventInput): Promise<ExecutionEventRecord>;
  listForExecution(executionRecordId: string): Promise<ExecutionEventRecord[]>;
  findByIdempotencyKey(key: string): Promise<ExecutionEventRecord | null>;
}

/** One-time, short-lived handoff token record (hash persisted, never raw). */
export interface ExecutionHandoffRecord {
  readonly id: string;
  readonly executionRecordId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface ExecutionHandoffRepository {
  create(input: {
    executionRecordId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ExecutionHandoffRecord>;
  findLatestByHash(tokenHash: string): Promise<ExecutionHandoffRecord | null>;
  consume(id: string, consumedAt: Date): Promise<ExecutionHandoffRecord | null>;
}

// ---------------------------------------------------------------------
// WORK-027 (PR #30 review fix #2): scoped execution CALLBACK credentials.
//
// The future Companion extension reports execution events with a CALLBACK
// TOKEN — never the user's general WorkflowOS API key. Callback tokens are
// scoped to exactly ONE execution + event ingestion ONLY, short-lived,
// hashed at rest, multi-use (started→progress→completed are distinct
// events; per-event idempotency is enforced via idempotencyKey), and are
// consumed by NO route other than POST /execution/:id/events.
// ---------------------------------------------------------------------

/** Persisted callback credential row (hash only — never the raw token). */
export interface ExecutionCallbackRecord {
  readonly id: string;
  readonly executionRecordId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ExecutionCallbackRepository {
  create(input: {
    executionRecordId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ExecutionCallbackRecord>;
  findLatestByHash(tokenHash: string): Promise<ExecutionCallbackRecord | null>;
}

/** Typed callback failure — the route maps `code` to an HTTP status. */
export class ExecutionCallbackError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'execution-not-found'
      | 'not-external-execution'
      | 'invalid-execution-state'
      | 'callback-token-invalid'
      | 'callback-token-expired'
      | 'execution-expired',
  ) {
    super(message);
    this.name = 'ExecutionCallbackError';
  }
}

/** Issued callback credential: the RAW token is returned at preparation time only. */
export interface IssuedExecutionCallback {
  readonly executionId: string;
  readonly callbackToken: string;
  readonly expiresAt: Date;
}

/** A validated callback credential (scoped to exactly one execution). */
export interface ValidatedExecutionCallback {
  readonly executionId: string;
  readonly executionRecordId: string;
}

/**
 * Scoped execution callback boundary. Issues + validates the event-ingestion
 * credential for exactly one external execution. This is the ONLY credential
 * the Companion extension needs — it grants NO other capability (no project
 * reads, no package reads, no workflow/verification/review mutation, no
 * arbitrary project.write operations).
 */
export interface ExecutionCallbackService {
  issue(executionId: string): Promise<IssuedExecutionCallback>;
  validate(executionId: string, rawToken: string): Promise<ValidatedExecutionCallback>;
}

/** Typed handoff failure — the route maps `code` to an HTTP status. */
export class ExecutionHandoffError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'execution-not-found'
      | 'not-external-execution'
      | 'invalid-execution-state'
      | 'handoff-token-invalid'
      | 'handoff-token-expired'
      | 'handoff-token-already-used'
      | 'execution-expired'
      // WORK-037 (additive): the agent-policy external-handoff eligibility
      // gate (PolicyGatedExecutionHandoffService). The route maps these to
      // 403 / 422 respectively. Non-breaking for existing callers.
      | 'handoff-policy-denied'
      | 'handoff-policy-approval-required',
  ) {
    super(message);
    this.name = 'ExecutionHandoffError';
  }
}

/** Issued handoff: the RAW token is returned to the authorized caller once. */
export interface IssuedExecutionHandoff {
  readonly executionId: string;
  readonly handoffToken: string;
  readonly expiresAt: Date;
}

/** Result of redeeming a handoff token — the full external package. */
export interface RedeemedExecutionPackage {
  readonly executionId: string;
  readonly status: ExecutionState;
  readonly package: ExternalExecutionPackage;
  /**
   * WORK-037 (additive, advisory): when the agent-policy external-handoff
   * decision is 'constrained', the redeemed package carries the policy
   * constraints (timeoutMs/maxOutputBytes/readOnly) for the external
   * runtime to honor. The external runtime is NOT a WorkflowOS host; these
   * constraints are communicated, not enforced host-side. Absent when the
   * decision is 'allow'.
   */
  readonly policyConstraints?: import('./tool-runtime.types.js').ToolPolicyConstraints;
}
/**
 * WORK-028: result of a COMPANION redemption (token-only, no API key). The
 * extension receives the execution record + the full external package; the
 * ROUTE additionally issues the scoped callback credential.
 */
export interface CompanionRedeemedHandoff {
  readonly record: ExecutionRecord;
  readonly status: ExecutionState;
  readonly pkg: ExternalExecutionPackage;
}

/**
 * Handoff boundary: issues + redeems one-time, short-lived, project-scoped
 * tokens that gate ExternalExecutionPackage retrieval. Redeeming consumes the
 * token (replay-protected) and requires the CALLER to be authorized for the
 * execution's project — a stolen token alone is never sufficient.
 *
 * WORK-028: redeemByToken is the COMPANION path — authentication by the
 * one-time token ALONE (the extension holds no WorkflowOS API key). The
 * hash → handoff → record lookup scopes the redemption to exactly one
 * execution; one-time consumption semantics are identical.
 */
export interface ExecutionHandoffService {
  issue(executionId: string): Promise<IssuedExecutionHandoff>;
  redeem(executionId: string, rawToken: string): Promise<RedeemedExecutionPackage>;
  /** WORK-028: one-time token-only companion redemption. */
  redeemByToken(rawToken: string): Promise<CompanionRedeemedHandoff>;
}

/** Typed ingestion failure — the route maps `code` to an HTTP status. */
export class ExecutionEventError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'execution-not-found'
      | 'native-execution-events-not-allowed'
      | 'invalid-event-type'
      | 'invalid-execution-state'
      | 'execution-expired',
  ) {
    super(message);
    this.name = 'ExecutionEventError';
  }
}

/** Input for the provider-independent external result ingestion boundary. */
export interface IngestExecutionEventInput {
  readonly executionId: string;
  readonly eventType: 'started' | 'progress' | 'completed' | 'failed';
  readonly commitRef?: string | null;
  readonly branch?: string | null;
  readonly pullRequestRef?: string | null;
  readonly testSummary?: Record<string, unknown> | null;
  readonly output?: string | null;
  readonly externalSessionRef?: string | null;
  readonly idempotencyKey?: string | null;
}

export interface IngestedExecutionEvent {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly executionId: string;
  readonly status: ExecutionState;
}

/**
 * External result ingestion boundary. Updates ONLY the execution record (+
 * audit + events table). It NEVER mutates workflow/verification/review state —
 * WorkflowOS observes authoritative GitHub/CI/verification/review state
 * through the existing boundaries.
 */
export interface ExecutionEventIngestionService {
  ingest(input: IngestExecutionEventInput): Promise<IngestedExecutionEvent>;
}

/** Result of submitting an ExecutionTask through the provider boundary. */
export interface ExecutionSubmitResult {
  readonly executionId: string;
  readonly mode: ExecutionMode;
  readonly provider: string;
  readonly status: ExecutionState;
  readonly agentRunId: string | null;
  readonly repositoryRef: string | null;
  readonly branch: string | null;
  readonly expiresAt: Date | null;
  readonly implementationContextId: string;
}

/**
 * WORK-027 execution submission boundary. Creates the execution record,
 * dispatches to the ExecutionProvider matching the task's mode, persists the
 * outcome, and emits audit events. This is the ONLY entry point for both
 * native and external execution.
 */
export interface ExecutionService {
  submit(task: ExecutionTask): Promise<ExecutionSubmitResult>;
}
