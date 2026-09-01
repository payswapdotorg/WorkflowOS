/**
 * V2-006 — Teaching Sessions: the public domain contracts.
 *
 * The domain lives at `src/teaching-sessions/` (application-layer pure domain
 * module, mirroring the workflow-ir / node-capability precedent — NOT a
 * frozen module; no persistence, no routes, no migration). It owns EXACTLY
 * the Work Order V2-006 scope:
 *
 *   - TeachingSession identity/state bound to an immutable WorkflowVersion
 *     reference carried as DATA (workflow id + version id + the V2-003
 *     SEMANTIC digest, consumed from the merged workflow-ir barrel — never
 *     recomputed or redefined here);
 *   - the derived lesson (a VIEW over workflow meaning: intent,
 *     prerequisites, steps, decision points, observations, completion
 *     criteria) with typed NOT_SPECIFIED_BY_WORKFLOW disclosures wherever the
 *     IR lacks a fact — teaching NEVER invents procedural facts;
 *   - checkpoints with explicit learner confirmation, optional human
 *     practice, learner progress, pause/resume, unresolved learner
 *     questions;
 *   - teaching-specific evidence as its own explicitly-typed evidence class
 *     (class "teaching"), strictly distinct from the registry's execution
 *     completion-evidence classes and from any run/execution concept.
 *
 * BOUNDARY CONTRACT (spec/architecture/v2/work-orders/V2-006.md + the
 * teaching model spec/architecture/v2/workflow-teaching-and-marketplace.md):
 *
 *   - NOT Workflow/WorkflowVersion repository persistence (V2-002): the
 *     pinned version reference is opaque data; the repository is the source
 *     of the installed version, consumed read-only.
 *   - NOT canonical WorkflowIR (V2-003): the lesson is a DERIVED VIEW over
 *     the IR document, never a second workflow format; the module never
 *     mutates the WorkflowVersion/IR (constitution §3/§8).
 *   - NOT Node/Capability semantics (V2-004): capability names appearing in
 *     teaching content are canonical registry names quoted from the IR.
 *   - NOT WorkflowRun execution/evidence (V2-005), compiler (V2-007),
 *     computer-agent runtime, scheduling, optimization, reverse-teaching
 *     orchestration, or marketplace economics.
 *   - NO execution-attestation concepts: the V2-014 protocol objects are a
 *     different domain. Teaching evidence is not execution evidence — a
 *     learner completing a lesson does not create an execution record, and
 *     an execution result does not prove the learner can perform the task.
 *   - NO authorization engine: permissions are session-scoped only (the
 *     session learner is the single bounded authority for session
 *     operations). Capability advertisement is never authorization
 *     (registry authority rules); teaching permission is its own bounded
 *     dimension.
 *   - Durable session persistence is out of this wave's scope: the module
 *     defines the resumable session STATE and a store port; the in-memory
 *     store is the reference composition (durable storage is a later,
 *     separately-owned concern).
 */
import type {
  CompletionEvidenceClass,
  ExecutionClass,
  PlacementId,
  WorkflowIrDocument,
  WorkflowVersionSemanticDigest,
} from '../workflow-ir/index.js';

// ============================================================================
// §0  Teaching evidence — its own class, never an execution concept
// ============================================================================

/**
 * The teaching evidence class. Distinct BY CONSTRUCTION from:
 *   - the registry evidence vocabulary (intent, observation, claim,
 *     verification, human_confirmation — those are classes that can
 *     establish EXECUTION step completion, constitution §7);
 *   - the registry execution-attestation object types (V2-014 domain);
 *   - any run/evidence concept of V2-005.
 *
 * Teaching evidence records LEARNING facts (a learner confirmed
 * understanding, practiced, was assessed) — never that a workflow step's
 * side effect happened.
 */
export const TEACHING_EVIDENCE_CLASS = 'teaching' as const;
export type TeachingEvidenceClass = typeof TEACHING_EVIDENCE_CLASS;

/** The kinds of teaching evidence (all learner-teaching concepts). */
export const TEACHING_EVIDENCE_KINDS = [
  'learner_checkpoint_confirmation',
  'learner_practice_attempt',
  'learner_assessment_outcome',
] as const;
export type TeachingEvidenceKind = (typeof TEACHING_EVIDENCE_KINDS)[number];

/** One teaching evidence record (typed teaching fact, JSON-safe detail). */
export interface TeachingEvidenceRecord {
  readonly evidenceClass: TeachingEvidenceClass;
  readonly kind: TeachingEvidenceKind;
  readonly id: string;
  readonly sessionId: string;
  readonly learnerId: string;
  /** injected-clock timestamp (ms) — never a wall clock. */
  readonly recordedAt: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

// ============================================================================
// §1  The pinned immutable WorkflowVersion reference (carried as DATA)
// ============================================================================

/**
 * The immutable WorkflowVersion a session is bound to. The semantic digest
 * is the V2-003 WorkflowVersion semantic digest as computed by the MERGED
 * workflow-ir barrel — this module never recomputes or redefines the digest
 * algorithm; it consumes the merged implementation to VERIFY supplied
 * teaching content against the pinned value (version pinning).
 */
export interface PinnedWorkflowVersion {
  readonly workflowId: string;
  readonly versionId: string;
  readonly semanticDigest: WorkflowVersionSemanticDigest;
}

// ============================================================================
// §2  The derived lesson (a VIEW over workflow meaning)
// ============================================================================

/** The typed disclosure emitted when the IR does not specify a fact. */
export const NOT_SPECIFIED_DISCLOSURE_KIND = 'NOT_SPECIFIED_BY_WORKFLOW' as const;
export type TeachingDisclosureKind = typeof NOT_SPECIFIED_DISCLOSURE_KIND;

/** The facts a lesson can disclose as not specified by the workflow. */
export type TeachingDisclosureField =
  | 'workflow_goal'
  | 'step_human_readable_semantics'
  | 'subworkflow_semantics'
  | 'step_completion_evidence';

/** A typed disclosure: the workflow does not contain this fact. */
export interface TeachingDisclosure {
  readonly kind: TeachingDisclosureKind;
  /** the IR path the disclosure is about (e.g. `$.ir.nodes.fetch_ticket`). */
  readonly subjectPath: string;
  readonly field: TeachingDisclosureField;
  /** the fixed disclosure sentence (template — never invented prose). */
  readonly message: string;
}

/** The kinds of traceable facts a lesson step can state. */
export type TeachingFactKind =
  | 'execution_class'
  | 'capability'
  | 'task'
  | 'human_kind'
  | 'human_instruction'
  | 'decision_options'
  | 'provided_port'
  | 'subworkflow_reference'
  | 'input_binding'
  | 'output_port'
  | 'placement'
  | 'failure_policy'
  | 'completion_evidence';

/**
 * One teaching fact: a value that is either a VERBATIM IR string or a
 * canonical rendering of a declared structural field, with the IR source
 * path it came from (mechanical traceability — the no-invention guarantee).
 */
export interface TeachingFact {
  readonly kind: TeachingFactKind;
  readonly value: string;
  readonly sourcePath: string;
}

/** The declared step semantics, quoted verbatim from the IR NodeSpec. */
export type StepSemantics =
  | { readonly class: 'deterministic_api'; readonly capability: string }
  | { readonly class: 'agentic_computer_use'; readonly task: string }
  | {
      readonly class: 'human';
      readonly kind: string;
      readonly instruction: string;
      readonly options?: readonly string[];
      readonly provides?: string;
    }
  | { readonly class: 'subworkflow'; readonly workflowId: string; readonly versionRef: string };

/** A step's declared input port with its canonical binding rendering. */
export interface LessonStepInput {
  readonly port: string;
  readonly typeKind: string;
  readonly binding: string;
}

/** A step's declared output port. */
export interface LessonStepOutput {
  readonly port: string;
  readonly typeKind: string;
}

/** A declared incoming control-edge condition a step depends on. */
export interface EdgeCondition {
  readonly from: string;
  readonly trigger: string;
}

/** One lesson step: a checkpoint with its explanation, facts, disclosures. */
export interface LessonStep {
  readonly nodeId: string;
  /** 1-based checkpoint position in the canonical teaching order. */
  readonly position: number;
  readonly executionClass: ExecutionClass;
  readonly semantics: StepSemantics;
  readonly facts: readonly TeachingFact[];
  readonly disclosures: readonly TeachingDisclosure[];
  readonly inputs: readonly LessonStepInput[];
  readonly outputs: readonly LessonStepOutput[];
  readonly placement: PlacementId;
  /** canonical rendering, e.g. `retry_then_fail_workflow(maxAttempts=2)`. */
  readonly failurePolicy: string;
  /** null = the workflow does not declare how completion is established. */
  readonly completionEvidence: CompletionEvidenceClass | null;
  /** declared incoming control edges (branch conditions). */
  readonly conditionalOn: readonly EdgeCondition[];
  /** rendered ONLY from facts + disclosures by fixed templates. */
  readonly explanation: string;
}

/** The workflow-level intent (derived from declared facts + disclosures). */
export interface LessonIntent {
  readonly startNodeId: string;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly provenanceOrigin: string;
  readonly disclosures: readonly TeachingDisclosure[];
  readonly statement: string;
}

/** What the learner/operator must have before starting. */
export type LessonPrerequisiteKind = 'workflow_input' | 'required_capability' | 'placement';

export interface LessonPrerequisite {
  readonly kind: LessonPrerequisiteKind;
  readonly value: string;
  readonly sourcePath: string;
}

/** What the workflow expects the human to decide (constitution §6.3). */
export interface LessonDecisionPoint {
  readonly nodeId: string;
  readonly humanKind: string;
  readonly instruction: string;
  readonly outcomes: readonly string[];
  readonly leadsTo: readonly {
    readonly outcome: string;
    readonly nextNodeIds: readonly string[];
  }[];
}

/** What the workflow observes / establishes (its declared observables). */
export type LessonObservationKind = 'step_output' | 'step_completion_evidence' | 'workflow_output';

export interface LessonObservation {
  readonly kind: LessonObservationKind;
  readonly value: string;
  readonly sourcePath: string;
}

/** The workflow's declared completion surface. */
export type LessonCompletionCriterionKind = 'workflow_output' | 'terminal_step';

export interface LessonCompletionCriterion {
  readonly kind: LessonCompletionCriterionKind;
  readonly value: string;
  readonly sourcePath: string;
}

/**
 * The derived lesson: a deterministic VIEW over one WorkflowIR document.
 * Never a second workflow format, never an execution authority, never
 * mutated by teaching.
 */
export interface DerivedLesson {
  /** the canonical checkpoint sequence (deterministic declared-order traversal). */
  readonly stepOrder: readonly string[];
  readonly intent: LessonIntent;
  readonly prerequisites: readonly LessonPrerequisite[];
  readonly steps: readonly LessonStep[];
  readonly decisionPoints: readonly LessonDecisionPoint[];
  readonly observations: readonly LessonObservation[];
  readonly completionCriteria: readonly LessonCompletionCriterion[];
  /** every disclosure of the lesson (workflow-level + per-step). */
  readonly disclosures: readonly TeachingDisclosure[];
}

// ============================================================================
// §3  The TeachingSession (resumable learner state)
// ============================================================================

export const TEACHING_SESSION_STATUSES = ['not_started', 'in_progress', 'paused', 'completed'] as const;
export type TeachingSessionStatus = (typeof TEACHING_SESSION_STATUSES)[number];

/** One confirmed checkpoint. */
export interface ConfirmedCheckpoint {
  readonly nodeId: string;
  readonly position: number;
  readonly confirmedAt: number;
}

/** The projected learner progress (derived from session state + evidence). */
export interface LearnerProgress {
  readonly confirmedCheckpoints: readonly ConfirmedCheckpoint[];
  readonly nextCheckpointNodeId: string | null;
  readonly allCheckpointsConfirmed: boolean;
  readonly practiceAttemptCount: number;
  readonly correctPracticeAttemptCount: number;
  readonly assessmentAttemptCount: number;
  readonly passedAssessment: boolean;
}

/** An unresolved (or resolved) learner question retained by the session. */
export interface LearnerQuestion {
  readonly id: string;
  readonly question: string;
  readonly raisedAt: number;
  readonly resolvedAt: number | null;
}

/**
 * A resumable TeachingSession bound to one immutable WorkflowVersion
 * (constitution §8: derived from workflow meaning; may contain learner
 * state, checkpoints and teaching evidence; may never mutate the source
 * WorkflowVersion).
 */
export interface TeachingSession {
  readonly id: string;
  readonly learnerId: string;
  readonly pinned: PinnedWorkflowVersion;
  readonly status: TeachingSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** set at beginLesson; the derived view over the pinned version. */
  readonly lesson: DerivedLesson | null;
  /** the deep-frozen snapshot of the pinned document (never mutated). */
  readonly pinnedDocument: WorkflowIrDocument | null;
  readonly confirmedCheckpoints: readonly ConfirmedCheckpoint[];
  readonly unresolvedQuestions: readonly LearnerQuestion[];
  readonly evidence: readonly TeachingEvidenceRecord[];
  readonly progress: LearnerProgress;
}

// ============================================================================
// §4  Practice and the independent performance assessment
// ============================================================================

/** A practice question derived from the workflow's own declared facts. */
export interface PracticeQuestion {
  readonly id: string;
  readonly kind: 'step_semantics';
  readonly nodeId: string;
  readonly prompt: string;
  /** options drawn ONLY from the workflow's own declared step semantics. */
  readonly options: readonly string[];
}

/** The typed result of one practice attempt (never a session error). */
export type PracticeAttemptResult =
  | {
      readonly outcome: 'correct';
      readonly attemptId: string;
      readonly nodeId: string;
      readonly feedback: string;
    }
  | {
      readonly outcome: 'incorrect';
      readonly attemptId: string;
      readonly nodeId: string;
      readonly feedback: string;
      /** the correction: the workflow's own declared semantics, quoted. */
      readonly declaredSemantic: string;
    };

/** Per-step assessment outcome. */
export interface AssessmentPerStepResult {
  readonly nodeId: string;
  readonly semanticsCorrect: boolean;
}

/**
 * The outcome of the independent task-performance assessment: the module's
 * own evaluation of whether the learner can perform the task WITHOUT
 * step-by-step teaching (the learner reproduces the workflow's declared
 * step order and each step's declared semantics).
 */
export interface AssessmentOutcome {
  readonly assessmentId: string;
  readonly passed: boolean;
  readonly orderCorrect: boolean;
  readonly perStep: readonly AssessmentPerStepResult[];
  /** corrections quoting the workflow's own declarations (never invented). */
  readonly corrections: readonly string[];
  readonly sessionStatus: TeachingSessionStatus;
}

/** The result of resuming a paused session (the exact pending checkpoint). */
export interface ResumeResult {
  readonly session: TeachingSession;
  readonly resumeCheckpointNodeId: string | null;
}

// ============================================================================
// §5  Service inputs
// ============================================================================

export interface CreateTeachingSessionInput {
  readonly learnerId: string;
  readonly pinned: PinnedWorkflowVersion;
}

export interface BeginLessonInput {
  readonly sessionId: string;
  readonly document: WorkflowIrDocument;
}

export interface SessionReadInput {
  readonly sessionId: string;
  readonly learnerId: string;
}

export interface ConfirmCheckpointInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly nodeId: string;
}

export interface PracticeAttemptInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly nodeId: string;
  readonly answer: string;
}

export interface SessionActionInput {
  readonly sessionId: string;
  readonly learnerId: string;
}

export interface AssessmentInput {
  readonly sessionId: string;
  readonly learnerId: string;
  /** the learner's reproduction of the workflow's step order. */
  readonly orderedStepIds: readonly string[];
  /** the learner's recall of each step's declared semantics. */
  readonly semanticsByStep: Readonly<Record<string, string>>;
}

export interface RaiseQuestionInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly question: string;
}

export interface ResolveQuestionInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly questionId: string;
}

// ============================================================================
// §6  The service contract, the store port and the injected sources
// ============================================================================

/**
 * The teaching-session service: session lifecycle, lesson attachment
 * (version-pinned), checkpoint confirmation, practice, pause/resume,
 * assessment, learner questions — all session-learner-scoped.
 */
export interface TeachingSessionService {
  /** Create a session bound to a pinned immutable version (not_started). */
  createSession(input: CreateTeachingSessionInput): TeachingSession;

  /** Read one session (learner-scoped). */
  getSession(input: SessionReadInput): TeachingSession;

  /**
   * Attach teaching content: verify the semantic digest against the pin
   * (VERSION_PIN_MISMATCH otherwise), validate the IR (merged V2-003
   * validation), derive the lesson and transition to in_progress.
   * Idempotent when the content matches the pin.
   */
  beginLesson(input: BeginLessonInput): TeachingSession;

  /** Read the derived lesson (learner-scoped). */
  getLesson(input: SessionReadInput): DerivedLesson;

  /** List practice questions derived from the workflow's own facts. */
  listPracticeQuestions(input: SessionReadInput): readonly PracticeQuestion[];

  /** Explicitly confirm the NEXT checkpoint in order. */
  confirmCheckpoint(input: ConfirmCheckpointInput): TeachingSession;

  /** Attempt an optional practice answer (typed outcome, session unharmed). */
  attemptPractice(input: PracticeAttemptInput): PracticeAttemptResult;

  /** Pause the session (in_progress → paused). */
  pauseSession(input: SessionActionInput): TeachingSession;

  /** Resume to the exact pending checkpoint (paused → in_progress). */
  resumeSession(input: SessionActionInput): ResumeResult;

  /** Submit the independent performance assessment (pass completes). */
  submitIndependentPerformance(input: AssessmentInput): AssessmentOutcome;

  /** Raise an unresolved learner question (retained across pause/resume). */
  raiseQuestion(input: RaiseQuestionInput): TeachingSession;

  /** Mark a raised question resolved. */
  resolveQuestion(input: ResolveQuestionInput): TeachingSession;
}

/** The session state store port (durable storage is a later concern). */
export interface TeachingSessionStore {
  put(session: TeachingSession): void;
  get(sessionId: string): TeachingSession | undefined;
}

/** Injected deterministic sources (identity + clock). */
export interface TeachingSessionServiceDeps {
  readonly idFactory: () => string;
  readonly clock: () => number;
  readonly store: TeachingSessionStore;
}

// ============================================================================
// §7  The typed error surface (fail-closed rejections)
// ============================================================================

export const TEACHING_SESSION_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_NOT_ACTIVE',
  'SESSION_NOT_PAUSED',
  'SESSION_ALREADY_PAUSED',
  'SESSION_ALREADY_COMPLETED',
  'LEARNER_NOT_AUTHORIZED',
  'LESSON_NOT_BEGUN',
  'CHECKPOINT_NOT_IN_LESSON',
  'CHECKPOINT_OUT_OF_ORDER',
  'CHECKPOINT_ALREADY_CONFIRMED',
  'CHECKPOINTS_NOT_COMPLETE',
  'PRACTICE_STEP_NOT_IN_LESSON',
  'ASSESSMENT_INVALID_STRUCTURE',
  'VERSION_PIN_MISMATCH',
  'PIN_DIGEST_ALGORITHM_UNSUPPORTED',
  'PIN_DIGEST_DOMAIN_MISMATCH',
  'IR_DOCUMENT_INVALID',
  'IR_GRAPH_CYCLE',
  'QUESTION_NOT_FOUND',
  'QUESTION_ALREADY_RESOLVED',
  'TEACHING_INPUT_INVALID',
] as const;
export type TeachingSessionErrorCode = (typeof TEACHING_SESSION_ERROR_CODES)[number];

/** Typed, fail-closed error for teaching-session operations. */
export class TeachingSessionError extends Error {
  readonly code: TeachingSessionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TeachingSessionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`teaching-sessions: ${code}: ${message}`);
    this.name = 'TeachingSessionError';
    this.code = code;
    this.details = details;
  }
}
