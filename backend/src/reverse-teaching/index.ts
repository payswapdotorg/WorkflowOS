/**
 * V2-010 — Reverse Teaching (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-010.md): the reverse-teaching
 * derivation (purpose, prerequisites, inputs, steps, decision points,
 * expected outcomes extracted as a manual-task view over an installed
 * immutable WorkflowVersion), per-step manual actionability with typed
 * uncertainty disclosures (never invented procedural facts), unsafe
 * instruction handling through the V2-008-sensitive-capability gate, the
 * interactive manual lesson with pause/resume, learner practice state, and
 * teaching evidence specific to an installed WorkflowVersion.
 *
 * Deliberately does NOT own: the ordinary TeachingSession implementation
 * (V2-006 — its derivation, service and store are consumed read-only through
 * this barrel's sibling, never modified, never re-exported as ours),
 * Workflow/WorkflowVersion repository persistence and installation lifecycle
 * (V2-002 — the pin is data; the repository resolves it), canonical
 * WorkflowIR (V2-003 — consumed via the merged barrel for validation and the
 * semantic digest), computer-agent execution (V2-008 — only its sensitive
 * capability classification is consumed), workflow runs / execution evidence
 * (V2-005), scheduling/events (V2-009), optimization (V2-011), marketplace
 * economics, or any execution-attestation concept (V2-014).
 *
 * EVIDENCE SEPARATION (constitution §7 + the teaching model): reverse
 * teaching records LEARNING facts in the teaching evidence class (V2-006's
 * class value, composed) — never execution completion evidence, never a run
 * concept, never an execution-attestation protocol object. A learner
 * completing the manual task does not create an execution record.
 *
 * EXECUTION/TEACHING DISTINCTION: performing the taught task manually is
 * LEARNING. The workflow executing the task is EXECUTION (V2-005/V2-008).
 * This module creates zero runs and imports no run concept; the dogfooding
 * comparison drives both paths side by side through their own authorities.
 */
export {
  // §0 reverse-teaching evidence (the teaching class, reverse-specific kinds)
  REVERSE_TEACHING_EVIDENCE_KINDS,
  // §3 session lifecycle
  REVERSE_TEACHING_SESSION_STATUSES,
  // §6 typed error surface
  REVERSE_TEACHING_ERROR_CODES,
  ReverseTeachingError,
} from './types.js';
export type {
  ReverseTeachingEvidenceKind,
  ReverseTeachingEvidenceRecord,
  InstalledVersionPin,
  ManualActionability,
  ManualInstructionBasis,
  ReverseTeachingDisclosureField,
  ReverseTeachingDisclosure,
  ManualSafetyClassification,
  ReverseTeachingStep,
  ReverseTeachingPurpose,
  ExpectedOutcome,
  ReverseTeachingLesson,
  ReverseTeachingSessionStatus,
  ManualStepMode,
  ManualStepPerformance,
  SafetyAcknowledgment,
  ReverseTeachingLearnerProgress,
  ReverseTeachingSession,
  ReverseTeachingResumeResult,
  ReverseTeachingFinalization,
  CreateReverseTeachingSessionInput,
  BeginReverseTeachingInput,
  ReverseTeachingSessionReadInput,
  SafetyAcknowledgmentInput,
  PerformManualStepInput,
  ReverseTeachingSessionActionInput,
  FinalizeLessonInput,
  ReverseTeachingSessionService,
  ReverseTeachingSessionStore,
  ReverseTeachingSessionServiceDeps,
  ReverseTeachingErrorCode,
} from './types.js';

// The reverse-teaching derivation (a deterministic manual-task VIEW over one
// pinned WorkflowIR document, composed over the merged V2-006 lesson).
export { deriveReverseTeachingLesson } from './internal/derivation.js';

// The service (injected deterministic sources; store port).
export { DefaultReverseTeachingSessionService } from './internal/reverse-teaching-session-service.js';

// The reference store + deterministic source factories (tests + dogfooding).
export {
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
} from './internal/in-memory-store.js';
