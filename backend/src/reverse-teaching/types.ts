/**
 * V2-010 — Reverse Teaching: the public domain contracts.
 *
 * The domain lives at `src/reverse-teaching/` (application-layer pure domain
 * module, mirroring the workflow-ir / teaching-sessions / computer-agent
 * precedent — NOT a frozen module; no persistence, no routes, no migration).
 * It owns EXACTLY the Work Order V2-010 scope (the "TEACH ME" mode of the
 * teaching model, spec/architecture/v2/workflow-teaching-and-marketplace.md):
 *
 *   - the reverse-teaching session bound to an INSTALLED immutable
 *     WorkflowVersion (the installation pin carried as DATA: installation id
 *     + workflow id + version id + the V2-003 SEMANTIC digest, consumed from
 *     the merged workflow-ir barrel — never recomputed or redefined here);
 *   - the reverse-teaching derivation: extraction of purpose, prerequisites,
 *     inputs, steps, decision points and expected outcomes as a DERIVED VIEW
 *     over the installed version's WorkflowIR document — composed on the
 *     merged V2-006 lesson derivation (never a second lesson format, never a
 *     second workflow format, never an execution authority);
 *   - per-step MANUAL actionability: what a person performs by hand vs what
 *     the workflow executes itself, with typed uncertainty disclosures
 *     wherever the workflow lacks required teaching context (teaching NEVER
 *     invents procedural facts);
 *   - unsafe instruction handling: steps whose declared capability
 *     requirements intersect the V2-008 computer-agent runtime's SENSITIVE
 *     capability set (consumed read-only through the merged barrel) are
 *     safety-gated — an explicit learner safety acknowledgment is required
 *     before a manual performance is accepted;
 *   - the interactive manual lesson with ordered learner performance,
 *     pause/resume to the exact pending step, and finalization;
 *   - reverse-teaching evidence: teaching evidence SPECIFIC to an installed
 *     WorkflowVersion — the SAME teaching evidence class as V2-006 (the
 *     class value is consumed, not redefined), with reverse-teaching-specific
 *     kinds; it records LEARNING facts only.
 *
 * BOUNDARY CONTRACT (spec/architecture/v2/work-orders/V2-010.md + the
 * teaching model + the architecture constitution):
 *
 *   - NOT the ordinary TeachingSession implementation (V2-006): the
 *     reverse-teaching session is the Work Order's OWN distinct artifact
 *     (manual performance, not checkpoint confirmation); V2-006's service,
 *     store and session types are never modified and never re-exported as
 *     this module's own;
 *   - NOT Workflow/WorkflowVersion repository persistence or installation
 *     lifecycle (V2-002): the installed version is resolved read-only through
 *     the merged repository (routes in the integration/dogfooding
 *     composition); the pin is opaque data here;
 *   - NOT canonical WorkflowIR (V2-003): the reverse-teaching lesson is a
 *     derived view over the IR document (consumed via the merged
 *     parser/validator/digest); the module never mutates the installed
 *     WorkflowVersion/IR (constitution §3/§8);
 *   - NOT computer-agent execution (V2-008): only the safe-action SENSITIVE
 *     capability classification is consumed (contract-level, read-only);
 *     executing steps is the runtime's domain — here the HUMAN performs the
 *     task manually, and the module records learning facts only;
 *   - NOT workflow execution semantics, runs or execution evidence (V2-005):
 *     performing the taught task manually creates ZERO run records — the
 *     execution/teaching distinction is structural (no run concept exists in
 *     this module's API surface or evidence records);
 *   - NO execution-attestation concepts (V2-014 domain);
 *   - NO authorization engine: the session learner is the single bounded
 *     authority for session operations (session-scoped permission only);
 *   - NO scheduling/events (V2-009), optimization (V2-011) or marketplace
 *     economics.
 */
import type { WorkflowIrDocument } from '../workflow-ir/index.js';
import type {
  DerivedLesson,
  LessonStep,
  PinnedWorkflowVersion,
  TeachingEvidenceClass,
} from '../teaching-sessions/index.js';

// ============================================================================
// §0  Reverse-teaching evidence — teaching evidence specific to an installed
//     WorkflowVersion (the SAME class as V2-006; reverse-specific kinds)
// ============================================================================

/**
 * The reverse-teaching evidence kinds. They are TEACHING evidence kinds
 * (learning facts about a learner performing a workflow's task manually) —
 * deliberately disjoint from V2-006's ordinary-session kinds
 * (learner_checkpoint_confirmation, learner_practice_attempt,
 * learner_assessment_outcome) and from every execution-evidence concept.
 */
export const REVERSE_TEACHING_EVIDENCE_KINDS = [
  'learner_manual_step_performed',
  'learner_step_disclosure_acknowledged',
  'learner_safety_acknowledgment',
  'learner_manual_task_finalized',
] as const;
export type ReverseTeachingEvidenceKind = (typeof REVERSE_TEACHING_EVIDENCE_KINDS)[number];

/**
 * One reverse-teaching evidence record: a typed LEARNING fact, specific to an
 * installed WorkflowVersion (the pin is carried on every record — that is
 * what makes this evidence "specific to an installed WorkflowVersion").
 *
 * The evidenceClass value is V2-006's TEACHING_EVIDENCE_CLASS (composed, not
 * redefined): teaching evidence records LEARNING facts, never that a
 * workflow step's side effect happened, never an execution-attestation
 * protocol object, never a run concept.
 */
export interface ReverseTeachingEvidenceRecord {
  readonly evidenceClass: TeachingEvidenceClass;
  readonly kind: ReverseTeachingEvidenceKind;
  readonly id: string;
  readonly sessionId: string;
  readonly learnerId: string;
  /** the installed WorkflowVersion this learning fact belongs to. */
  readonly pin: Readonly<InstalledVersionPin>;
  /** injected-clock timestamp (ms) — never a wall clock. */
  readonly recordedAt: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

// ============================================================================
// §1  The installed-version pin (carried as DATA)
// ============================================================================

/**
 * The immutable INSTALLED WorkflowVersion a reverse-teaching session is bound
 * to. Extends V2-006's PinnedWorkflowVersion with the installation identity:
 * a V2-002 WorkflowInstallation pins ONE exact (workflow, version) tuple for
 * the installing organization — the reverse-teaching session binds to that
 * installation's pin. The semantic digest is V2-003's (consumed from the
 * merged barrel to verify supplied content against the pin).
 */
export interface InstalledVersionPin extends PinnedWorkflowVersion {
  /** the V2-002 installation that pins the exact version (opaque data). */
  readonly installationId: string;
}

// ============================================================================
// §2  The reverse-teaching derivation (a VIEW over the installed version)
// ============================================================================

/**
 * How a workflow step relates to MANUAL performance by the learner:
 *
 *   - `human_declared`        — a human step: the workflow declares the
 *                               instruction the person performs verbatim;
 *   - `agent_task`            — an agentic_computer_use step: the person
 *                               learns to perform the computer task the
 *                               workflow's agent would perform (the declared
 *                               task is the only instruction basis);
 *   - `system_performed`      — a deterministic_api step: the WORKFLOW
 *                               executes it itself; the workflow declares NO
 *                               manual equivalent for a person (disclosed);
 *   - `subworkflow_reference` — a subworkflow step: the manual procedure
 *                               lives in the referenced version (opaque
 *                               reference; its own semantics are not declared
 *                               here — disclosed).
 */
export type ManualActionability =
  | 'human_declared'
  | 'agent_task'
  | 'system_performed'
  | 'subworkflow_reference';

/** What declared fact the rendered manual instruction is based on. */
export type ManualInstructionBasis =
  | 'declared_human_instruction'
  | 'declared_agent_task'
  | 'declared_capability_name'
  | 'declared_subworkflow_reference';

/** The facts whose manual-teaching absence a derivation can disclose. */
export type ReverseTeachingDisclosureField =
  | 'manual_equivalent'
  | 'subworkflow_manual_procedure'
  | 'expected_outcome_observation';

/** A typed reverse-teaching disclosure: the workflow cannot teach this. */
export interface ReverseTeachingDisclosure {
  /** same disclosure kind as V2-006's (NOT_SPECIFIED_BY_WORKFLOW). */
  readonly kind: 'NOT_SPECIFIED_BY_WORKFLOW';
  /** the IR path the disclosure is about. */
  readonly subjectPath: string;
  readonly field: ReverseTeachingDisclosureField;
  /** the fixed disclosure sentence (template — never invented prose). */
  readonly message: string;
}

/** The sensitivity classification consumed from V2-008's safe-action vocabulary. */
export type ManualSafetyClassification = 'ordinary' | 'safety_gated';

/**
 * One reverse-teaching step: the manual-task framing of one lesson step,
 * composed over the V2-006 base step (facts, disclosures, inputs/outputs,
 * placement, failure policy — never re-derived, never mutated).
 */
export interface ReverseTeachingStep {
  readonly nodeId: string;
  /** 1-based position in the canonical manual performance order. */
  readonly position: number;
  /** what the workflow itself executes for this step (V2-006 base step's class). */
  readonly executionClass: LessonStep['executionClass'];
  /** what the person performs by hand (the reverse-teaching view). */
  readonly actionability: ManualActionability;
  readonly manualInstructionBasis: ManualInstructionBasis;
  /**
   * The manual instruction: a FIXED template rendering of ONLY the declared
   * fact (the verbatim human instruction / the declared agent task / the
   * canonical capability name / the subworkflow reference). Never an
   * invented procedure.
   */
  readonly manualInstruction: string;
  /** safety classification of MANUAL performance (V2-008 consumed). */
  readonly safety: ManualSafetyClassification;
  /** the declared capability requirements classified sensitive (verbatim names). */
  readonly sensitiveCapabilities: readonly string[];
  /** the fixed safety notice rendered for safety-gated steps (null otherwise). */
  readonly safetyNotice: string | null;
  /** what the workflow cannot teach for MANUAL performance of this step. */
  readonly uncertainty: readonly ReverseTeachingDisclosure[];
  /** the composed V2-006 base step (the workflow-meaning view, read-only). */
  readonly lessonStep: LessonStep;
}

/** The manual-task purpose: the composed V2-006 intent + the TEACH ME framing. */
export interface ReverseTeachingPurpose {
  /** the composed V2-006 lesson intent (inputs, outputs, provenance, disclosures). */
  readonly intent: DerivedLesson['intent'];
  /**
   * The fixed TEACH ME purpose statement: interpolates only declared facts
   * (start, inputs, outputs, provenance origin) and the V2-006 goal
   * disclosure when the workflow declares no goal.
   */
  readonly statement: string;
}

/** What the workflow declares it expects to observe / produce (composed). */
export interface ExpectedOutcome {
  readonly kind: 'workflow_output' | 'terminal_step' | 'step_output' | 'step_completion_evidence';
  readonly value: string;
  readonly sourcePath: string;
}

/**
 * The derived reverse-teaching lesson: a deterministic VIEW over one pinned
 * WorkflowIR document, composed over the merged V2-006 lesson derivation.
 * Never a second workflow format, never a second lesson format, never an
 * execution authority, never mutated by teaching.
 */
export interface ReverseTeachingLesson {
  /** the composed V2-006 base lesson (the full workflow-meaning view). */
  readonly base: DerivedLesson;
  /** the canonical manual performance order (identical to base.stepOrder). */
  readonly stepOrder: readonly string[];
  readonly purpose: ReverseTeachingPurpose;
  /** composed from base.prerequisites (inputs, capabilities, placements). */
  readonly prerequisites: DerivedLesson['prerequisites'];
  readonly steps: readonly ReverseTeachingStep[];
  /** composed from base.decisionPoints — what the human must decide. */
  readonly decisionPoints: DerivedLesson['decisionPoints'];
  /** composed from base.completionCriteria + base.observations. */
  readonly expectedOutcomes: readonly ExpectedOutcome[];
  /** every reverse-teaching uncertainty disclosure (manual dimension). */
  readonly uncertainty: readonly ReverseTeachingDisclosure[];
}

// ============================================================================
// §3  The reverse-teaching session (resumable manual-task learner state)
// ============================================================================

export const REVERSE_TEACHING_SESSION_STATUSES = [
  'not_started',
  'in_progress',
  'paused',
  'completed',
] as const;
export type ReverseTeachingSessionStatus = (typeof REVERSE_TEACHING_SESSION_STATUSES)[number];

/** The mode in which the learner completes one manual lesson step. */
export type ManualStepMode =
  | 'performed'
  | 'acknowledged_disclosure';

/** One performed (or disclosure-acknowledged) manual lesson step. */
export interface ManualStepPerformance {
  readonly nodeId: string;
  readonly position: number;
  readonly mode: ManualStepMode;
  /**
   * The learner's own record of what they did / observed (their words for a
   * performed step; the fixed disclosure acknowledgment sentence for an
   * acknowledged step).
   */
  readonly learnerResult: string;
  readonly performedAt: number;
}

/** One explicit learner safety acknowledgment of a safety-gated step. */
export interface SafetyAcknowledgment {
  readonly nodeId: string;
  readonly acknowledgedAt: number;
}

/** The projected learner progress (derived from session state + evidence). */
export interface ReverseTeachingLearnerProgress {
  readonly performedSteps: readonly ManualStepPerformance[];
  readonly nextStepNodeId: string | null;
  readonly allStepsPerformed: boolean;
  readonly safetyAcknowledgedStepIds: readonly string[];
  readonly performedStepCount: number;
  readonly disclosureAcknowledgedStepCount: number;
}

/**
 * A resumable reverse-teaching session bound to one INSTALLED immutable
 * WorkflowVersion. May contain learner state and teaching evidence; may
 * never mutate the installed WorkflowVersion; never creates execution
 * records (performing the taught task manually is LEARNING, not execution).
 */
export interface ReverseTeachingSession {
  readonly id: string;
  readonly learnerId: string;
  readonly pin: InstalledVersionPin;
  readonly status: ReverseTeachingSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** set at beginLesson; the derived reverse-teaching view. */
  readonly lesson: ReverseTeachingLesson | null;
  /** the deep-frozen snapshot of the pinned document (never mutated). */
  readonly pinnedDocument: WorkflowIrDocument | null;
  readonly performedSteps: readonly ManualStepPerformance[];
  readonly safetyAcknowledgments: readonly SafetyAcknowledgment[];
  readonly evidence: readonly ReverseTeachingEvidenceRecord[];
  readonly progress: ReverseTeachingLearnerProgress;
}

/** The result of resuming a paused session (the exact pending manual step). */
export interface ReverseTeachingResumeResult {
  readonly session: ReverseTeachingSession;
  readonly resumeStepNodeId: string | null;
}

/** The finalization outcome of a completed manual lesson. */
export interface ReverseTeachingFinalization {
  readonly sessionId: string;
  readonly finalizedAt: number;
  readonly performedStepCount: number;
  readonly disclosureAcknowledgedStepCount: number;
  readonly evidenceCount: number;
  readonly sessionStatus: ReverseTeachingSessionStatus;
}

// ============================================================================
// §4  Service inputs
// ============================================================================

export interface CreateReverseTeachingSessionInput {
  readonly learnerId: string;
  readonly pin: InstalledVersionPin;
}

export interface BeginReverseTeachingInput {
  readonly sessionId: string;
  readonly document: WorkflowIrDocument;
}

export interface ReverseTeachingSessionReadInput {
  readonly sessionId: string;
  readonly learnerId: string;
}

export interface SafetyAcknowledgmentInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly nodeId: string;
}

export interface PerformManualStepInput {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly nodeId: string;
  readonly mode: ManualStepMode;
  readonly learnerResult: string;
}

export interface ReverseTeachingSessionActionInput {
  readonly sessionId: string;
  readonly learnerId: string;
}

export interface FinalizeLessonInput {
  readonly sessionId: string;
  readonly learnerId: string;
}

// ============================================================================
// §5  The service contract, the store port and the injected sources
// ============================================================================

/**
 * The reverse-teaching session service: session lifecycle, lesson attachment
 * (install-pinned), manual performance in canonical order with safety
 * gating, disclosure acknowledgment, pause/resume and finalization — all
 * session-learner-scoped.
 */
export interface ReverseTeachingSessionService {
  /** Create a session bound to an installed immutable version (not_started). */
  createSession(input: CreateReverseTeachingSessionInput): ReverseTeachingSession;

  /** Read one session (learner-scoped). */
  getSession(input: ReverseTeachingSessionReadInput): ReverseTeachingSession;

  /**
   * Attach the installed version's content: verify the semantic digest
   * against the pin (VERSION_PIN_MISMATCH otherwise), validate the IR
   * (merged V2-003 validation), derive the reverse-teaching lesson and
   * transition to in_progress. Idempotent when the content matches the pin.
   */
  beginLesson(input: BeginReverseTeachingInput): ReverseTeachingSession;

  /** Read the derived reverse-teaching lesson (learner-scoped). */
  getLesson(input: ReverseTeachingSessionReadInput): ReverseTeachingLesson;

  /**
   * Explicitly acknowledge the safety notice of one safety-gated step
   * (required before that step's manual performance is accepted).
   */
  acknowledgeStepSafety(input: SafetyAcknowledgmentInput): ReverseTeachingSession;

  /**
   * Perform (or disclosure-acknowledge) the NEXT manual step in canonical
   * order. Safety-gated steps require a prior safety acknowledgment; the
   * mode must match the step's actionability; 'performed' requires a
   * non-empty learner result.
   */
  performManualStep(input: PerformManualStepInput): ReverseTeachingSession;

  /** Pause the session (in_progress → paused). */
  pauseSession(input: ReverseTeachingSessionActionInput): ReverseTeachingSession;

  /** Resume to the exact pending manual step (paused → in_progress). */
  resumeSession(input: ReverseTeachingSessionActionInput): ReverseTeachingResumeResult;

  /**
   * Finalize the manual lesson (requires every step performed or
   * disclosure-acknowledged); records the finalization evidence and
   * completes the session.
   */
  finalizeLesson(input: FinalizeLessonInput): ReverseTeachingFinalization;
}

/** The session state store port (durable storage is a later concern). */
export interface ReverseTeachingSessionStore {
  put(session: ReverseTeachingSession): void;
  get(sessionId: string): ReverseTeachingSession | undefined;
}

/** Injected deterministic sources (identity + clock). */
export interface ReverseTeachingSessionServiceDeps {
  readonly idFactory: () => string;
  readonly clock: () => number;
  readonly store: ReverseTeachingSessionStore;
}

// ============================================================================
// §6  The typed error surface (fail-closed rejections)
// ============================================================================

export const REVERSE_TEACHING_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_NOT_ACTIVE',
  'SESSION_NOT_PAUSED',
  'SESSION_ALREADY_PAUSED',
  'SESSION_ALREADY_COMPLETED',
  'LEARNER_NOT_AUTHORIZED',
  'LESSON_NOT_BEGUN',
  'STEP_NOT_IN_LESSON',
  'STEP_OUT_OF_ORDER',
  'STEP_ALREADY_PERFORMED',
  'SAFETY_ACKNOWLEDGMENT_REQUIRED',
  'SAFETY_ACKNOWLEDGMENT_NOT_APPLICABLE',
  'SAFETY_ACKNOWLEDGMENT_ALREADY_GIVEN',
  'MANUAL_MODE_MISMATCH',
  'LEARNER_RESULT_INVALID',
  'STEPS_NOT_COMPLETE',
  'INSTALLATION_PIN_INVALID',
  'VERSION_PIN_MISMATCH',
  'PIN_DIGEST_ALGORITHM_UNSUPPORTED',
  'PIN_DIGEST_DOMAIN_MISMATCH',
  'IR_DOCUMENT_INVALID',
  'IR_GRAPH_CYCLE',
  'REVERSE_TEACHING_INPUT_INVALID',
] as const;
export type ReverseTeachingErrorCode = (typeof REVERSE_TEACHING_ERROR_CODES)[number];

/** Typed, fail-closed error for reverse-teaching operations. */
export class ReverseTeachingError extends Error {
  readonly code: ReverseTeachingErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReverseTeachingErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`reverse-teaching: ${code}: ${message}`);
    this.name = 'ReverseTeachingError';
    this.code = code;
    this.details = details;
  }
}
