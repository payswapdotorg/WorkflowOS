/**
 * V2-006 — Teaching Sessions (public barrel).
 *
 * Owns (spec/architecture/v2/work-orders/V2-006.md): TeachingSession
 * identity/state bound to an immutable WorkflowVersion (pinned as data),
 * the derived lesson (step-by-step explanation with typed
 * NOT_SPECIFIED_BY_WORKFLOW disclosures — never invented facts), checkpoints
 * with explicit learner confirmation, optional human practice, learner
 * progress, pause/resume, unresolved learner questions, and teaching
 * evidence as its own explicitly-typed evidence class.
 *
 * Deliberately does NOT own: Workflow/WorkflowVersion repository persistence
 * (V2-002 — consumed read-only as the pinned version source), canonical
 * WorkflowIR (V2-003 — consumed read-only via the merged public barrel for
 * validation and the semantic digest), Node/Capability protocol (V2-004),
 * WorkflowRun execution/evidence (V2-005), the compiler (V2-007),
 * computer-agent runtime, scheduling, optimization, reverse teaching, or
 * marketplace economics.
 *
 * EVIDENCE SEPARATION (constitution §7 + the teaching model): teaching
 * evidence records LEARNING facts and is never the registry's execution
 * completion-evidence vocabulary, never a run concept, and never an
 * execution-attestation protocol object (V2-014 owns that separate domain).
 * A learner completing a lesson does not create an execution record.
 *
 * Teaching never mutates the installed workflow: the session deep-freezes a
 * snapshot of the pinned document, and no API writes back to any workflow
 * surface.
 */
export {
  // §0 teaching evidence (its own class)
  TEACHING_EVIDENCE_CLASS,
  TEACHING_EVIDENCE_KINDS,
  // §2 the derived lesson
  NOT_SPECIFIED_DISCLOSURE_KIND,
  // §3 session lifecycle
  TEACHING_SESSION_STATUSES,
  // §7 typed error surface
  TEACHING_SESSION_ERROR_CODES,
  TeachingSessionError,
} from './types.js';
export type {
  TeachingEvidenceClass,
  TeachingEvidenceKind,
  TeachingEvidenceRecord,
  PinnedWorkflowVersion,
  TeachingDisclosureKind,
  TeachingDisclosureField,
  TeachingDisclosure,
  TeachingFactKind,
  TeachingFact,
  StepSemantics,
  LessonStepInput,
  LessonStepOutput,
  EdgeCondition,
  LessonStep,
  LessonIntent,
  LessonPrerequisiteKind,
  LessonPrerequisite,
  LessonDecisionPoint,
  LessonObservationKind,
  LessonObservation,
  LessonCompletionCriterionKind,
  LessonCompletionCriterion,
  DerivedLesson,
  TeachingSessionStatus,
  ConfirmedCheckpoint,
  LearnerProgress,
  LearnerQuestion,
  TeachingSession,
  PracticeQuestion,
  PracticeAttemptResult,
  AssessmentPerStepResult,
  AssessmentOutcome,
  ResumeResult,
  CreateTeachingSessionInput,
  BeginLessonInput,
  SessionReadInput,
  ConfirmCheckpointInput,
  PracticeAttemptInput,
  SessionActionInput,
  AssessmentInput,
  RaiseQuestionInput,
  ResolveQuestionInput,
  TeachingSessionService,
  TeachingSessionStore,
  TeachingSessionServiceDeps,
  TeachingSessionErrorCode,
} from './types.js';

export { deriveLessonFromIrDocument } from './internal/lesson-derivation.js';
export { DefaultTeachingSessionService } from './internal/teaching-session-service.js';
export {
  InMemoryTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
} from './internal/in-memory-session-store.js';
