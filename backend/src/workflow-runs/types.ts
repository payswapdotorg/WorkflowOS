/**
 * V2-005 — Workflow Runs + Evidence: the public contracts.
 *
 * WORK ORDER: spec/architecture/v2/work-orders/V2-005.md
 * SPEC: spec/architecture/v2/execution-control-plane.md (run lifecycle/evidence)
 *   + spec/architecture/v2/execution-attestation.md (the V2-014 normative
 *     contract this module binds to — consumed, NEVER redefined)
 * REGISTRY: spec/architecture/v2/V2-CTRL-003-protocol-registry.md (+ .json)
 * CONSTITUTION: §2 hierarchy (WorkflowRun = one execution instance of one
 *   pinned deployment/version), §7 evidence truth, §11 event-triggered
 *   idempotency, §19 forbidden drift, §21 attestation boundaries.
 *
 * The domain lives at `src/workflow-runs/` (application-layer module — the
 * V2-002 workflow-repository structural precedent). It owns EXACTLY the
 * V2-005 scope:
 *
 *   - WorkflowRun identity pinned to workflow/version/installation/trigger/
 *     input identity (composite (workflow, version) tuple integrity — a
 *     version from another workflow is structurally unrunnable);
 *   - step + capability invocation records (canonical registry capability
 *     names verbatim; steps reference the pinned version's declared
 *     semantics);
 *   - DISTINCT evidence records over the registry evidence vocabulary
 *     (intent|observation|claim|verification|human_confirmation) with
 *     REQUIRED provenance — classes never impersonate one another;
 *   - references/bindings to ExecutionDigest/ExecutionAttestation where the
 *     configured execution path produces them: attaching an attestation
 *     verifies (merged V2-014 verifier + run-boundary checks) the digest, the
 *     statement's run/attempt/step binding, freshness, and DURABLE single-use
 *     replay state in THIS module's tables;
 *   - the explicit run state machine (requested → running → paused →
 *     running → completed|failed|cancelled) enforced in the module AND in
 *     PostgreSQL (migration 0061 guard trigger);
 *   - idempotent commands with deterministic correlation + causation (the
 *     durable command log makes duplicate submission converge typed and
 *     exactly-once);
 *   - crash/retry reconstruction: the persisted run alone rebuilds the full
 *     execution history (state timeline, attempts, steps, invocations,
 *     evidence, attestation bindings, command log) — a model assertion is
 *     NEVER proof of a side effect.
 *
 * ATTEMPT RULE (module-header documentation, pinned by tests): attempt 1
 * begins at run start; an explicit PAUSE suspends the current attempt and an
 * explicit RESUME CONTINUES that same attempt at the exact recorded step; a
 * DECLARED interruption (interruptRunAttempt — the executor reports the
 * attempt lost) closes the attempt and the next resume RESTARTS as a NEW
 * attempt (crash-retry). The module never guesses a crash — it records what
 * the commanded execution path reports.
 *
 * BOUNDARY CONTRACT (load-bearing, pinned by
 * tests/unit/workflow-runs/module-boundary.test.ts):
 *
 *   - NOT repository/version semantics (V2-002) — the merged repository
 *     service is consumed read-only through its public barrel for pin
 *     resolution; NOT WorkflowIR semantics (V2-003) — the merged parse +
 *     semantic digest are consumed for step declaration and binding
 *     expectations; NOT Node/capability authority (V2-004); NOT
 *     computer-use execution (V2-008) or scheduling/events (V2-009).
 *   - NOT attestation protocol semantics (V2-014): this module NEVER signs,
 *     NEVER re-implements a verification check, and NEVER hard-codes V2-014's
 *     object-type identifiers — the merged barrel's parse/verify functions
 *     are the verification authority at the Run boundary; durable replay
 *     state (V2-014's evidence limitation: its InMemoryReplayRegistry was
 *     reference-only) is EXPLICITLY V2-005's and lives in these tables.
 *   - NO second evidence/verification authority: verification evidence is
 *     recorded only for boundary-verified facts; rejected attestations are
 *     recorded as TYPED boundary rejections, never as evidence; a
 *     cryptographically valid signature with failed/insufficient verification
 *     is never auto-accepted (registry authorityRules:
 *     signature-is-not-automatic-execution-truth,
 *     attestation-is-not-verification-authority).
 *   - PostgreSQL is the authority: no in-memory run state is a source of
 *     truth; every command is transactional against the durable tables; the
 *     DDL itself (unique constraints, composite FKs, the state-machine
 *     trigger, terminal immutability) survives a buggy application caller.
 *   - NO secrets: runs record input/output CONTENT COMMITMENTS only
 *     (statement-privacy rules — raw parameter values never enter).
 *   - Timeline event names: registry event names are used VERBATIM (a strict
 *     subset of the frozen registry list). The registry defines NO
 *     cancellation or attempt-interruption event, so those two transitions
 *     are recorded under deliberately MODULE-scoped timeline names
 *     ('run.cancelled', 'run.attempt.interrupted') that never pose as
 *     registry protocol event names (pinned by the registry-conformance
 *     battery; recorded as an honest vocabulary observation in the
 *     dogfooding evidence).
 */

import type { DatabaseClient } from '@platform/index.js';
import type {
  OrganizationMembershipResolver,
  WorkflowRepositoryService,
} from '../workflow-repository/index.js';
import type { ExecutionAttestation, AssuranceLevel } from '../execution-attestation/index.js';

// The principal contract is the merged identity authority's (consumed
// read-only — the run module never redefines principal semantics).
export type { WorkflowPrincipal } from '../workflow-repository/index.js';
import type { WorkflowPrincipal } from '../workflow-repository/index.js';

// ============================================================================
// §0 Vocabularies (frozen V2-CTRL-003 registry identifiers, verbatim)
// ============================================================================

/** Canonical evidence classes (registry: evidence — constitution §7). */
export const RUN_EVIDENCE_CLASSES = [
  'intent',
  'observation',
  'claim',
  'verification',
  'human_confirmation',
] as const;
export type RunEvidenceClass = (typeof RUN_EVIDENCE_CLASSES)[number];

/** Canonical execution classes (registry: executionClasses — constitution §6). */
export const RUN_EXECUTION_CLASSES = [
  'deterministic_api',
  'agentic_computer_use',
  'human',
  'subworkflow',
] as const;
export type RunExecutionClass = (typeof RUN_EXECUTION_CLASSES)[number];

/**
 * Trigger categories (constitution §11 — manual, schedule, webhook,
 * application/file/communication/device/social-threshold/workflow-lifecycle
 * events). These are the CLOSED trigger-type vocabulary; the registry's
 * event-name list governs protocol event names, which these are NOT.
 */
export const RUN_TRIGGER_TYPES = [
  'manual',
  'schedule',
  'webhook',
  'application_event',
  'file_event',
  'communication_event',
  'device_event',
  'social_threshold_event',
  'workflow_lifecycle_event',
] as const;
export type RunTriggerType = (typeof RUN_TRIGGER_TYPES)[number];

// ============================================================================
// §1 The run state machine (registry run-event vocabulary)
// ============================================================================

/**
 * The run states. 'requested' (workflow.run.requested), 'running'
 * (started/resumed), 'paused' (workflow.run.paused), 'completed'
 * (workflow.run.completed), 'failed' (workflow.run.failed). 'cancelled' is a
 * terminal STATE; the registry defines no cancellation EVENT (see the
 * module-header boundary note).
 */
export const WORKFLOW_RUN_STATES = [
  'requested',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

/** Terminal states: lifecycle-immutable, evidence remains append-only. */
export const TERMINAL_WORKFLOW_RUN_STATES = ['completed', 'failed', 'cancelled'] as const;

/** Execution-attempt states within a run (see the ATTEMPT RULE in the header). */
export const RUN_ATTEMPT_STATES = ['running', 'suspended', 'interrupted', 'ended'] as const;
export type RunAttemptState = (typeof RUN_ATTEMPT_STATES)[number];

/** Step execution statuses. */
export const RUN_STEP_STATUSES = ['started', 'completed', 'failed'] as const;
export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

/** Step/invocation outcomes (what the executor CLAIMS happened — a claim, never side-effect evidence). */
export const RUN_INVOCATION_OUTCOMES = ['succeeded', 'failed'] as const;
export type RunInvocationOutcome = (typeof RUN_INVOCATION_OUTCOMES)[number];

/**
 * Registry event names this module projects into the run timeline (VERBATIM
 * registry names — a strict subset of the frozen registry event list).
 */
export const RUN_PROTOCOL_EVENT_NAMES = [
  'workflow.run.requested',
  'workflow.run.started',
  'workflow.run.paused',
  'workflow.run.resumed',
  'workflow.run.completed',
  'workflow.run.failed',
  'workflow.step.started',
  'workflow.step.completed',
  'capability.invocation.requested',
  'capability.invocation.completed',
  'observation.recorded',
  'verification.completed',
  'execution.attestation.verified',
] as const;
export type RunProtocolEventName = (typeof RUN_PROTOCOL_EVENT_NAMES)[number];

/**
 * The full timeline vocabulary: the registry protocol names PLUS the two
 * deliberately module-scoped transition names (the registry defines no
 * cancellation or attempt-interruption event; these markers never pose as
 * registry protocol event names — pinned by the registry-conformance
 * battery).
 */
export const RUN_TIMELINE_EVENT_NAMES = [
  ...RUN_PROTOCOL_EVENT_NAMES,
  'run.cancelled',
  'run.attempt.interrupted',
] as const;
export type RunTimelineEventName = (typeof RUN_TIMELINE_EVENT_NAMES)[number];

/** The durable command types (the command-log vocabulary). */
export const RUN_COMMAND_TYPES = [
  'request_run',
  'start_run',
  'pause_run',
  'resume_run',
  'interrupt_attempt',
  'cancel_run',
  'complete_run',
  'fail_run',
  'record_step_started',
  'record_step_completed',
  'record_invocation_requested',
  'record_invocation_completed',
  'record_evidence',
  'attach_attestation',
] as const;
export type RunCommandType = (typeof RUN_COMMAND_TYPES)[number];

// ============================================================================
// §2 Durable records (all timestamps are fixed-format UTC strings)
// ============================================================================

/** A run trigger: closed category + the external trigger/event identity. */
export interface RunTrigger {
  readonly type: RunTriggerType;
  readonly id: string;
}

/** One WorkflowRun — one execution instance of one pinned deployment/version. */
export interface WorkflowRun {
  readonly id: string;
  readonly organizationId: string;
  readonly workflowId: string;
  /** The pinned EXACT immutable version (composite (workflow, version) tuple). */
  readonly versionId: string;
  /** The pinned version's CONTENT digest (V2-002's — immutability/convergence proof). */
  readonly versionContentDigest: string;
  /** The pinned version's SEMANTIC digest (V2-003's — carried as pin data, never recomputed here). */
  readonly versionSemanticDigest: string;
  /** The installation/deployment reference where applicable (the V2-002 pin). */
  readonly installationId: string | null;
  readonly trigger: RunTrigger;
  readonly triggeredByUserId: string | null;
  /** One-way canonical input commitments (never raw parameter/secret values). */
  readonly inputCommitments: readonly string[];
  readonly inputDigest: string;
  readonly state: WorkflowRunState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One execution attempt within a run (the V2-014 statement binds attempt identity). */
export interface RunAttempt {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly state: RunAttemptState;
  /** The execution host identity (opaque external identity — V2-004's). */
  readonly nodeId: string | null;
  /** The exact step a suspended attempt will resume at (resume-to-exact-step). */
  readonly pausedAtStepId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** One step execution record (references the pinned version's declared step). */
export interface RunStepExecution {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId: string;
  readonly status: RunStepStatus;
  readonly inputCommitments: readonly string[];
  readonly outputCommitments: readonly string[];
  readonly outcome: RunInvocationOutcome | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** One capability invocation record (canonical registry capability name verbatim). */
export interface RunCapabilityInvocation {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId: string | null;
  readonly capability: string;
  readonly executionClass: RunExecutionClass;
  readonly inputCommitments: readonly string[];
  readonly outputCommitments: readonly string[];
  readonly outcome: RunInvocationOutcome | null;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

/** One evidence record — class + provenance + content commitment. */
export interface RunEvidenceRecord {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number | null;
  readonly stepId: string | null;
  readonly evidenceClass: RunEvidenceClass;
  /** Provenance: the producer's kind (executor/host/verifier/human/…). */
  readonly producerKind: string;
  /** Provenance: the producer's identity. */
  readonly producerId: string;
  /** One-way content commitment (never raw evidence payloads). */
  readonly contentCommitment: string;
  readonly description: string | null;
  readonly recordedAt: string;
}

/** A DURABLE attestation binding: the persisted record IS the single-use consumption. */
export interface RunAttestationBinding {
  readonly attestationId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId: string | null;
  readonly executionDigest: string;
  readonly attesterKeyId: string;
  readonly assurance: string;
  /** The single-use nonce (replay resistance — timestamps alone are insufficient). */
  readonly nonce: string;
  /** The canonical statement (commitment-based; no secrets by V2-014 construction). */
  readonly statement: Record<string, unknown>;
  readonly verifiedAt: string;
  readonly attachedAt: string;
}

/** A TYPED boundary rejection of an attestation (never evidence; append-only audit). */
export interface RunAttestationRejection {
  readonly id: string;
  readonly runId: string;
  readonly attestationId: string | null;
  readonly failureCode: string;
  readonly detail: string;
  readonly rejectedAt: string;
}

/** The durable command-log record (the exactly-once proof). */
export interface RunCommandRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly commandType: RunCommandType;
  readonly payloadDigest: string;
  /** The recorded outcome: a successful result value, or the typed rejection. */
  readonly result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly message: string };
  readonly executedAt: string;
}

/** One append-only timeline entry (registry protocol event names or module-scoped transition markers). */
export interface RunTimelineEntry {
  readonly id: string;
  readonly runId: string;
  readonly attemptNumber: number | null;
  readonly stepId: string | null;
  readonly eventName: RunTimelineEventName;
  readonly occurredAt: string;
  /** Insertion sequence within the run (stable reconstruction order). */
  readonly sequence: number;
  readonly detail: Record<string, unknown> | null;
}

/** The full reconstructed execution history (the crash-recovery projection). */
export interface WorkflowRunHistory {
  readonly run: WorkflowRun;
  readonly timeline: readonly RunTimelineEntry[];
  readonly attempts: readonly RunAttempt[];
  readonly steps: readonly RunStepExecution[];
  readonly invocations: readonly RunCapabilityInvocation[];
  readonly evidence: readonly RunEvidenceRecord[];
  readonly attestations: readonly RunAttestationBinding[];
  readonly attestationRejections: readonly RunAttestationRejection[];
  readonly commands: readonly RunCommandRecord[];
}

// ============================================================================
// §3 Commands: deterministic correlation + causation (idempotency)
// ============================================================================

/**
 * Every mutating command carries a deterministic idempotency/correlation
 * identity. `commandId` is the caller's unique key for THIS command (the
 * dedupe boundary — replay converges typed); `correlationId` groups the
 * commands of one logical flow (typically the trigger/event identity);
 * `causationId` references what PRODUCED this command (event id, parent
 * command).
 */
export interface RunCommandEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface RequestRunInput {
  readonly organizationId: string;
  readonly workflowId: string;
  readonly versionId: string;
  /** The installation/deployment pin (optional; `null` = no installation). */
  readonly installationId?: string | null;
  readonly trigger: RunTrigger;
  readonly inputCommitments: readonly string[];
}

export interface StartRunInput {
  readonly runId: string;
  readonly nodeId?: string;
}

export interface PauseRunInput {
  readonly runId: string;
  /** The step the executor is paused AT (the resume point). */
  readonly atStepId?: string;
}

export interface ResumeRunInput {
  readonly runId: string;
  readonly nodeId?: string;
}

export interface InterruptRunAttemptInput {
  readonly runId: string;
  readonly reason?: string;
}

export interface CancelRunInput {
  readonly runId: string;
  readonly reason?: string;
}

export interface CompleteRunInput {
  readonly runId: string;
  readonly outputCommitments?: readonly string[];
}

export interface FailRunInput {
  readonly runId: string;
  readonly reason?: string;
}

export interface RecordStepStartedInput {
  readonly runId: string;
  readonly stepId: string;
  readonly inputCommitments?: readonly string[];
}

export interface RecordStepCompletedInput {
  readonly runId: string;
  readonly stepId: string;
  readonly outcome: RunInvocationOutcome;
  readonly outputCommitments?: readonly string[];
}

export interface RecordInvocationRequestedInput {
  readonly runId: string;
  readonly capability: string;
  readonly executionClass: RunExecutionClass;
  readonly stepId?: string;
  readonly inputCommitments?: readonly string[];
}

export interface RecordInvocationCompletedInput {
  readonly runId: string;
  readonly invocationId: string;
  readonly outcome: RunInvocationOutcome;
  readonly outputCommitments?: readonly string[];
}

export interface RecordRunEvidenceInput {
  readonly runId: string;
  readonly attemptNumber?: number;
  readonly stepId?: string;
  readonly evidenceClass: RunEvidenceClass;
  readonly producerKind: string;
  readonly producerId: string;
  readonly contentCommitment: string;
  readonly description?: string;
}

export interface AttachRunAttestationInput {
  readonly runId: string;
  readonly attemptNumber: number;
  readonly stepId?: string;
  /** The attestation to attach (parsed envelope; verified at the boundary). */
  readonly attestation: ExecutionAttestation;
  /** Caller policy: attester trust, required assurance, max age (all optional). */
  readonly policy?: {
    readonly maxAgeMs?: number;
    readonly requiredAssurance?: AssuranceLevel;
    readonly trustedAttesterKeyIds?: readonly string[];
  };
}

// ============================================================================
// §4 Command results
// ============================================================================

export interface RequestRunResult {
  readonly run: WorkflowRun;
  /** false = converged on an existing run (duplicate trigger delivery). */
  readonly created: boolean;
}

export interface LifecycleRunResult {
  readonly run: WorkflowRun;
  readonly attempt: RunAttempt | null;
}

export interface ResumeRunResult {
  readonly run: WorkflowRun;
  readonly attempt: RunAttempt;
  /** The exact step the run resumed at (resume-to-exact-step). */
  readonly resumedAtStepId: string | null;
  /** true = the resume RESTARTED as a new attempt (crash-retry). */
  readonly newAttempt: boolean;
}

export interface RecordStepResult {
  readonly step: RunStepExecution;
}

export interface RecordInvocationResult {
  readonly invocation: RunCapabilityInvocation;
}

export interface RecordRunEvidenceResult {
  readonly evidence: RunEvidenceRecord;
  /** false = converged on the existing evidence record (re-delivery). */
  readonly created: boolean;
}

export interface AttachRunAttestationResult {
  readonly binding: RunAttestationBinding;
  /** The boundary-verification evidence recorded for the attach. */
  readonly evidence: RunEvidenceRecord;
}

/**
 * The outcome of one command: `executed` true = this call executed the
 * command; false = typed idempotent convergence on the recorded outcome of a
 * prior submission with the SAME command id (same result, no second side
 * effect — the durable command log proves exactly-once).
 */
export interface RunCommandOutcome<T> {
  readonly executed: boolean;
  readonly commandId: string;
  readonly result: T;
}

// ============================================================================
// §5 The injected clock + the service contract
// ============================================================================

/** The injected run clock (fixed-format UTC; never ambient). */
export interface WorkflowRunClock {
  now(): string;
}

export interface DefaultWorkflowRunServiceDeps {
  /** The authoritative PostgreSQL client (the persistence authority). */
  readonly db: DatabaseClient;
  /** The identity authority's membership fact source (consumed port). */
  readonly memberships: OrganizationMembershipResolver;
  /** The merged V2-002 repository service (read-only pin resolution). */
  readonly workflowRepository: WorkflowRepositoryService;
  /** The injected run clock. */
  readonly clock: WorkflowRunClock;
  /** The current protocol epoch (attestation freshness). */
  readonly currentEpoch: number;
}

/**
 * The workflow run service: the one authority for durable Run state and
 * evidence (V2-005). Every mutating operation is an idempotent command with
 * deterministic correlation + causation; reads are tenant-scoped with typed
 * uniform not-founds (no cross-tenant existence leak).
 */
export interface WorkflowRunService {
  requestRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RequestRunInput): Promise<RunCommandOutcome<RequestRunResult>>;
  startRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: StartRunInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  pauseRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: PauseRunInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  resumeRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: ResumeRunInput): Promise<RunCommandOutcome<ResumeRunResult>>;
  interruptRunAttempt(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: InterruptRunAttemptInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  cancelRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: CancelRunInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  completeRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: CompleteRunInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  failRun(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: FailRunInput): Promise<RunCommandOutcome<LifecycleRunResult>>;
  recordStepStarted(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RecordStepStartedInput): Promise<RunCommandOutcome<RecordStepResult>>;
  recordStepCompleted(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RecordStepCompletedInput): Promise<RunCommandOutcome<RecordStepResult>>;
  recordInvocationRequested(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RecordInvocationRequestedInput): Promise<RunCommandOutcome<RecordInvocationResult>>;
  recordInvocationCompleted(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RecordInvocationCompletedInput): Promise<RunCommandOutcome<RecordInvocationResult>>;
  recordEvidence(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: RecordRunEvidenceInput): Promise<RunCommandOutcome<RecordRunEvidenceResult>>;
  attachAttestation(principal: WorkflowPrincipal, command: RunCommandEnvelope, input: AttachRunAttestationInput): Promise<RunCommandOutcome<AttachRunAttestationResult>>;
  /** Read one run (tenant-scoped; denied reads are typed 404s — no existence leak). */
  getRun(principal: WorkflowPrincipal, runId: string): Promise<WorkflowRun>;
  /** Reconstruct the full execution history from the persisted Run alone. */
  getRunHistory(principal: WorkflowPrincipal, runId: string): Promise<WorkflowRunHistory>;
  /** List the tenant's runs (member-only, stable order). */
  listRunsInOrganization(principal: WorkflowPrincipal, organizationId: string): Promise<WorkflowRun[]>;
}

// ============================================================================
// §6 Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

export const WORKFLOW_RUN_ERROR_CODES = [
  'RUN_NOT_FOUND',
  'RUN_NOT_ORGANIZATION_MEMBER',
  'RUN_VERSION_NOT_OF_WORKFLOW',
  'RUN_VERSION_CONTENT_NOT_PARSEABLE',
  'RUN_INSTALLATION_MISMATCH',
  'RUN_INVALID_TRIGGER_TYPE',
  'RUN_INVALID_INPUT_COMMITMENTS',
  'RUN_INVALID_STATE_TRANSITION',
  'RUN_TERMINAL',
  'RUN_NOT_RUNNING',
  'RUN_ATTEMPT_NOT_FOUND',
  'RUN_STEP_NOT_DECLARED',
  'RUN_STEP_ALREADY_RECORDED',
  'RUN_INVOCATION_NOT_FOUND',
  'RUN_INVOCATION_ALREADY_COMPLETED',
  'RUN_CAPABILITY_NON_CANONICAL',
  'RUN_EXECUTION_CLASS_INVALID',
  'RUN_EVIDENCE_CLASS_INVALID',
  'RUN_EVIDENCE_PRODUCER_REQUIRED',
  'RUN_ATTESTATION_MALFORMED',
  'RUN_ATTESTATION_REJECTED',
  'RUN_ATTESTATION_REPLAYED',
  'RUN_COMMAND_ID_INVALID',
  'RUN_COMMAND_CORRELATION_ID_INVALID',
  'RUN_COMMAND_PAYLOAD_CONFLICT',
  /** History-read marker: a claimed-but-unfilled command (the crash window
   * between the exactly-once claim and the result fill). Never thrown. */
  'RUN_COMMAND_IN_FLIGHT',
  'RUN_INVALID_REQUEST',
] as const;

export type WorkflowRunErrorCode = (typeof WORKFLOW_RUN_ERROR_CODES)[number];

/** The typed workflow-runs error (discriminated by `code`). */
export class WorkflowRunError extends Error {
  readonly code: WorkflowRunErrorCode;

  constructor(code: WorkflowRunErrorCode, message: string) {
    super(`workflow-runs: ${message}`);
    this.name = 'WorkflowRunError';
    this.code = code;
  }
}
