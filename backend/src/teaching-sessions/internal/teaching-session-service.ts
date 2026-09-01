/**
 * V2-006 — the teaching-session service: session lifecycle, version pinning,
 * checkpoint confirmation, practice, pause/resume, assessment and learner
 * questions.
 *
 * Determinism: ALL ids and timestamps come from the injected factories
 * (deps.idFactory / deps.clock) — zero wall clock, zero randomness, zero
 * network. State is copy-on-write: every transition constructs a NEW frozen
 * session (deep-frozen snapshot of the pinned document and derived lesson
 * included) and puts it into the injected store; nothing outside the store
 * can alias mutable state.
 */
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
  WORKFLOW_IR_OBJECT_TYPE,
} from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import type {
  AssessmentInput,
  AssessmentOutcome,
  BeginLessonInput,
  ConfirmCheckpointInput,
  CreateTeachingSessionInput,
  DerivedLesson,
  LearnerProgress,
  LearnerQuestion,
  PinnedWorkflowVersion,
  PracticeAttemptInput,
  PracticeAttemptResult,
  PracticeQuestion,
  RaiseQuestionInput,
  ResolveQuestionInput,
  ResumeResult,
  SessionReadInput,
  SessionActionInput,
  TeachingSession,
  TeachingSessionService,
  TeachingSessionServiceDeps,
  TeachingSessionStatus,
} from '../types.js';
import { TeachingSessionError } from '../types.js';
import { deepClone, deepFreeze } from './immutable.js';
import { deriveLessonFromIrDocument, stepDeclaredSemanticText } from './lesson-derivation.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** Session-learner-state guard: every operation is learner-scoped. */
function requireLearner(session: TeachingSession, actingLearnerId: string): void {
  if (typeof actingLearnerId !== 'string' || actingLearnerId.length === 0) {
    throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'a non-empty learnerId is required');
  }
  if (session.learnerId !== actingLearnerId) {
    throw new TeachingSessionError(
      'LEARNER_NOT_AUTHORIZED',
      `learner "${actingLearnerId}" is not the learner of session ${session.id}`,
      { sessionLearnerId: session.learnerId, actingLearnerId },
    );
  }
}

/** Require the session to be in a status that permits learner progress. */
function requireActive(session: TeachingSession, operation: string): void {
  if (session.status === 'completed') {
    throw new TeachingSessionError(
      'SESSION_ALREADY_COMPLETED',
      `${operation} is impossible: session ${session.id} is completed (terminal)`,
    );
  }
  if (session.status !== 'in_progress') {
    throw new TeachingSessionError(
      'SESSION_NOT_ACTIVE',
      `${operation} requires an in_progress session; session ${session.id} is ${session.status}`,
      { status: session.status },
    );
  }
}

/** Project the learner progress from the session state + evidence. */
function projectProgress(session: TeachingSession): LearnerProgress {
  const lesson = session.lesson;
  const confirmed = [...session.confirmedCheckpoints];
  const order = lesson?.stepOrder ?? [];
  const nextCheckpointNodeId =
    order.find((nodeId) => !confirmed.some((checkpoint) => checkpoint.nodeId === nodeId)) ?? null;
  const practiceAttempts = session.evidence.filter((record) => record.kind === 'learner_practice_attempt');
  const assessments = session.evidence.filter((record) => record.kind === 'learner_assessment_outcome');
  return {
    confirmedCheckpoints: confirmed,
    nextCheckpointNodeId,
    allCheckpointsConfirmed: lesson !== null && order.length > 0 && nextCheckpointNodeId === null,
    practiceAttemptCount: practiceAttempts.length,
    correctPracticeAttemptCount: practiceAttempts.filter((record) => record.detail['correct'] === true).length,
    assessmentAttemptCount: assessments.length,
    passedAssessment: assessments.some((record) => record.detail['passed'] === true),
  };
}

/** Construct the next frozen session state (copy-on-write) and persist it. */
function nextSession(
  session: TeachingSession,
  patch: Partial<TeachingSession>,
  now: number,
  store: { put(session: TeachingSession): void },
): TeachingSession {
  const merged: TeachingSession = { ...session, ...patch, updatedAt: now };
  const updated: TeachingSession = { ...merged, progress: projectProgress(merged) };
  const frozen = deepFreeze(updated);
  store.put(frozen);
  return frozen;
}

/** Validate the pinned version reference shape (fail closed). */
function validatePinned(pinned: PinnedWorkflowVersion): void {
  if (typeof pinned.workflowId !== 'string' || pinned.workflowId.length === 0) {
    throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'pinned.workflowId must be a non-empty string');
  }
  if (typeof pinned.versionId !== 'string' || pinned.versionId.length === 0) {
    throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'pinned.versionId must be a non-empty string');
  }
  const digest: WorkflowVersionSemanticDigest | undefined = pinned.semanticDigest;
  if (digest === undefined || typeof digest !== 'object' || digest === null) {
    throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'pinned.semanticDigest is required');
  }
  if (digest.algorithm !== 'sha-256') {
    throw new TeachingSessionError(
      'PIN_DIGEST_ALGORITHM_UNSUPPORTED',
      `the pinned semantic digest algorithm must be sha-256 (got "${String(digest.algorithm)}")`,
      { algorithm: digest.algorithm },
    );
  }
  if (digest.domain !== WORKFLOW_IR_OBJECT_TYPE) {
    throw new TeachingSessionError(
      'PIN_DIGEST_DOMAIN_MISMATCH',
      `the pinned semantic digest domain must be ${WORKFLOW_IR_OBJECT_TYPE} (got "${String(digest.domain)}")`,
      { domain: digest.domain },
    );
  }
  if (typeof digest.digest !== 'string' || !HEX64.test(digest.digest)) {
    throw new TeachingSessionError(
      'TEACHING_INPUT_INVALID',
      'pinned.semanticDigest.digest must be a 64-character lowercase hex string',
    );
  }
}

/** Verify supplied teaching content against the pinned semantic digest. */
function verifyPin(session: TeachingSession, document: WorkflowIrDocument): void {
  const computed = computeWorkflowVersionSemanticDigest(document);
  if (
    computed.domain !== session.pinned.semanticDigest.domain ||
    computed.algorithm !== session.pinned.semanticDigest.algorithm ||
    computed.digest !== session.pinned.semanticDigest.digest
  ) {
    throw new TeachingSessionError(
      'VERSION_PIN_MISMATCH',
      `the supplied teaching content does not match the pinned WorkflowVersion semantic digest for session ${session.id}`,
      { pinnedDigest: session.pinned.semanticDigest.digest, suppliedDigest: computed.digest },
    );
  }
}

/** The canonical declared-semantics text of a lesson step. */
function declaredSemanticOf(lesson: DerivedLesson, nodeId: string): string {
  const step = lesson.steps.find((candidate) => candidate.nodeId === nodeId);
  if (step === undefined) {
    throw new TeachingSessionError(
      'PRACTICE_STEP_NOT_IN_LESSON',
      `step "${nodeId}" is not part of the lesson of this session`,
      { nodeId },
    );
  }
  return stepDeclaredSemanticText(step);
}

export class DefaultTeachingSessionService implements TeachingSessionService {
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private readonly store: TeachingSessionServiceDeps['store'];

  constructor(deps: TeachingSessionServiceDeps) {
    this.idFactory = deps.idFactory;
    this.clock = deps.clock;
    this.store = deps.store;
  }

  // --------------------------------------------------------------------------

  createSession(input: CreateTeachingSessionInput): TeachingSession {
    if (typeof input.learnerId !== 'string' || input.learnerId.trim().length === 0) {
      throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'learnerId must be a non-empty string');
    }
    validatePinned(input.pinned);
    const now = this.clock();
    const session: TeachingSession = {
      id: this.idFactory(),
      learnerId: input.learnerId,
      pinned: deepFreeze(deepClone(input.pinned)),
      status: 'not_started',
      createdAt: now,
      updatedAt: now,
      lesson: null,
      pinnedDocument: null,
      confirmedCheckpoints: [],
      unresolvedQuestions: [],
      evidence: [],
      progress: {
        confirmedCheckpoints: [],
        nextCheckpointNodeId: null,
        allCheckpointsConfirmed: false,
        practiceAttemptCount: 0,
        correctPracticeAttemptCount: 0,
        assessmentAttemptCount: 0,
        passedAssessment: false,
      },
    };
    this.store.put(session);
    return session;
  }

  private requireSession(sessionId: string): TeachingSession {
    const session = this.store.get(sessionId);
    if (session === undefined) {
      throw new TeachingSessionError('SESSION_NOT_FOUND', `no teaching session with id "${sessionId}"`);
    }
    return session;
  }

  getSession(input: SessionReadInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    return session;
  }

  // --------------------------------------------------------------------------

  beginLesson(input: BeginLessonInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    verifyPin(session, input.document);
    // Idempotent re-attachment of identical semantic content.
    if (session.lesson !== null) {
      return session;
    }
    const validation = validateWorkflowIrDocument(input.document);
    if (!validation.ok) {
      const summary = validation.issues
        .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
        .join('; ');
      throw new TeachingSessionError('IR_DOCUMENT_INVALID', `the pinned teaching content is not a valid WorkflowIR document: ${summary}`, {
        issues: validation.issues,
      });
    }
    const lesson = deriveLessonFromIrDocument(input.document);
    const pinnedDocument = deepFreeze(deepClone(input.document)) as WorkflowIrDocument;
    return nextSession(
      session,
      { status: 'in_progress', lesson, pinnedDocument },
      this.clock(),
      this.store,
    );
  }

  getLesson(input: SessionReadInput): DerivedLesson {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.lesson === null) {
      throw new TeachingSessionError('LESSON_NOT_BEGUN', `session ${session.id} has not begun a lesson yet`);
    }
    return session.lesson;
  }

  listPracticeQuestions(input: SessionReadInput): readonly PracticeQuestion[] {
    const lesson = this.getLesson(input);
    const options: string[] = [];
    for (const step of lesson.steps) {
      const semantics = stepDeclaredSemanticText(step);
      if (!options.includes(semantics)) options.push(semantics);
    }
    return lesson.steps.map((step) => ({
      id: `pq-${step.nodeId}`,
      kind: 'step_semantics' as const,
      nodeId: step.nodeId,
      prompt: `Which declared semantics does the workflow assign to step "${step.nodeId}"?`,
      options: [...options],
    }));
  }

  // --------------------------------------------------------------------------

  confirmCheckpoint(input: ConfirmCheckpointInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'checkpoint confirmation');
    const lesson = session.lesson!;
    if (!lesson.stepOrder.includes(input.nodeId)) {
      throw new TeachingSessionError(
        'CHECKPOINT_NOT_IN_LESSON',
        `step "${input.nodeId}" is not a checkpoint of this lesson`,
        { nodeId: input.nodeId },
      );
    }
    if (session.confirmedCheckpoints.some((checkpoint) => checkpoint.nodeId === input.nodeId)) {
      throw new TeachingSessionError(
        'CHECKPOINT_ALREADY_CONFIRMED',
        `checkpoint "${input.nodeId}" has already been confirmed`,
        { nodeId: input.nodeId },
      );
    }
    const expectedNext =
      lesson.stepOrder.find(
        (nodeId) => !session.confirmedCheckpoints.some((checkpoint) => checkpoint.nodeId === nodeId),
      ) ?? null;
    if (input.nodeId !== expectedNext) {
      throw new TeachingSessionError(
        'CHECKPOINT_OUT_OF_ORDER',
        `checkpoint "${input.nodeId}" is out of order: the next checkpoint to confirm is "${expectedNext}"`,
        { expectedNextNodeId: expectedNext, suppliedNodeId: input.nodeId },
      );
    }
    const now = this.clock();
    const position = lesson.stepOrder.indexOf(input.nodeId) + 1;
    const confirmedCheckpoints = [
      ...session.confirmedCheckpoints,
      { nodeId: input.nodeId, position, confirmedAt: now },
    ];
    const evidence = [
      ...session.evidence,
      {
        evidenceClass: 'teaching' as const,
        kind: 'learner_checkpoint_confirmation' as const,
        id: this.idFactory(),
        sessionId: session.id,
        learnerId: session.learnerId,
        recordedAt: now,
        detail: { nodeId: input.nodeId, position, acknowledged: 'understanding' },
      },
    ];
    return nextSession(session, { confirmedCheckpoints, evidence }, now, this.store);
  }

  attemptPractice(input: PracticeAttemptInput): PracticeAttemptResult {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'practice');
    const lesson = session.lesson!;
    if (typeof input.answer !== 'string') {
      throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'answer must be a string');
    }
    if (!lesson.stepOrder.includes(input.nodeId)) {
      throw new TeachingSessionError(
        'PRACTICE_STEP_NOT_IN_LESSON',
        `step "${input.nodeId}" is not part of the lesson of this session`,
        { nodeId: input.nodeId },
      );
    }
    const declaredSemantic = declaredSemanticOf(lesson, input.nodeId);
    const correct = input.answer.trim() === declaredSemantic;
    const attemptId = this.idFactory();
    const now = this.clock();
    const feedback = correct
      ? `Correct: the workflow declares exactly this semantics for step "${input.nodeId}".`
      : `Not the workflow declaration for step "${input.nodeId}". The workflow declares: "${declaredSemantic}". (The correction quotes the workflow own declared semantics.)`;
    const evidence = [
      ...session.evidence,
      {
        evidenceClass: 'teaching' as const,
        kind: 'learner_practice_attempt' as const,
        id: attemptId,
        sessionId: session.id,
        learnerId: session.learnerId,
        recordedAt: now,
        detail: { nodeId: input.nodeId, answer: input.answer, correct },
      },
    ];
    nextSession(session, { evidence }, now, this.store);
    return correct
      ? { outcome: 'correct', attemptId, nodeId: input.nodeId, feedback }
      : { outcome: 'incorrect', attemptId, nodeId: input.nodeId, feedback, declaredSemantic };
  }

  // --------------------------------------------------------------------------

  pauseSession(input: SessionActionInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new TeachingSessionError(
        'SESSION_ALREADY_COMPLETED',
        `pause is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status === 'paused') {
      throw new TeachingSessionError('SESSION_ALREADY_PAUSED', `session ${session.id} is already paused`);
    }
    if (session.status !== 'in_progress') {
      throw new TeachingSessionError(
        'SESSION_NOT_ACTIVE',
        `pause requires an in_progress session; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    return nextSession(session, { status: 'paused' }, this.clock(), this.store);
  }

  resumeSession(input: SessionActionInput): ResumeResult {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new TeachingSessionError(
        'SESSION_ALREADY_COMPLETED',
        `resume is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status !== 'paused') {
      throw new TeachingSessionError(
        'SESSION_NOT_PAUSED',
        `resume requires a paused session; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    const resumed = nextSession(session, { status: 'in_progress' as TeachingSessionStatus }, this.clock(), this.store);
    return { session: resumed, resumeCheckpointNodeId: resumed.progress.nextCheckpointNodeId };
  }

  // --------------------------------------------------------------------------

  submitIndependentPerformance(input: AssessmentInput): AssessmentOutcome {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'the independent performance assessment');
    const lesson = session.lesson!;
    if (!session.progress.allCheckpointsConfirmed) {
      throw new TeachingSessionError(
        'CHECKPOINTS_NOT_COMPLETE',
        `the independent performance assessment requires every checkpoint to be confirmed first (next: "${session.progress.nextCheckpointNodeId ?? 'none'}")`,
        { nextCheckpointNodeId: session.progress.nextCheckpointNodeId },
      );
    }
    const order = [...lesson.stepOrder];
    const submitted = [...input.orderedStepIds];
    const orderSet = new Set(order);
    const submittedSet = new Set(submitted);
    const semanticsKeys = new Set(Object.keys(input.semanticsByStep ?? {}));
    const structureValid =
      submitted.length === order.length &&
      submitted.every((nodeId) => orderSet.has(nodeId)) &&
      submittedSet.size === submitted.length &&
      order.every((nodeId) => submittedSet.has(nodeId)) &&
      order.every((nodeId) => semanticsKeys.has(nodeId)) &&
      semanticsKeys.size === order.length &&
      order.every((nodeId) => typeof input.semanticsByStep[nodeId] === 'string');
    if (!structureValid) {
      throw new TeachingSessionError(
        'ASSESSMENT_INVALID_STRUCTURE',
        'the assessment submission must list exactly the lesson steps once each and supply a semantics answer for every lesson step',
        { expectedStepIds: order, submittedStepIds: submitted },
      );
    }
    const orderCorrect = submitted.every((nodeId, index) => nodeId === order[index]);
    const perStep = order.map((nodeId) => ({
      nodeId,
      semanticsCorrect: (input.semanticsByStep[nodeId] ?? '').trim() === declaredSemanticOf(lesson, nodeId),
    }));
    const passed = orderCorrect && perStep.every((result) => result.semanticsCorrect);

    const corrections: string[] = [];
    if (!orderCorrect) {
      corrections.push(`The workflow declared control flow orders the steps as: ${order.join(', ')}.`);
    }
    for (const result of perStep) {
      if (!result.semanticsCorrect) {
        corrections.push(`Step "${result.nodeId}": the workflow declares "${declaredSemanticOf(lesson, result.nodeId)}".`);
      }
    }

    const assessmentId = this.idFactory();
    const now = this.clock();
    const evidence = [
      ...session.evidence,
      {
        evidenceClass: 'teaching' as const,
        kind: 'learner_assessment_outcome' as const,
        id: assessmentId,
        sessionId: session.id,
        learnerId: session.learnerId,
        recordedAt: now,
        detail: {
          passed,
          orderCorrect,
          semanticsCorrectCount: perStep.filter((result) => result.semanticsCorrect).length,
          totalSteps: order.length,
        },
      },
    ];
    const status: TeachingSessionStatus = passed ? 'completed' : session.status;
    const updated = nextSession(session, { evidence, status }, now, this.store);
    return {
      assessmentId,
      passed,
      orderCorrect,
      perStep,
      corrections,
      sessionStatus: updated.status,
    };
  }

  // --------------------------------------------------------------------------

  raiseQuestion(input: RaiseQuestionInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new TeachingSessionError(
        'SESSION_ALREADY_COMPLETED',
        `raising a question is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status === 'not_started') {
      throw new TeachingSessionError(
        'SESSION_NOT_ACTIVE',
        `questions require a begun lesson; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    if (typeof input.question !== 'string' || input.question.trim().length === 0) {
      throw new TeachingSessionError('TEACHING_INPUT_INVALID', 'question must be a non-empty string');
    }
    const now = this.clock();
    const question: LearnerQuestion = {
      id: this.idFactory(),
      question: input.question,
      raisedAt: now,
      resolvedAt: null,
    };
    return nextSession(
      session,
      { unresolvedQuestions: [...session.unresolvedQuestions, question] },
      now,
      this.store,
    );
  }

  resolveQuestion(input: ResolveQuestionInput): TeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new TeachingSessionError(
        'SESSION_ALREADY_COMPLETED',
        `resolving a question is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status === 'not_started') {
      throw new TeachingSessionError(
        'SESSION_NOT_ACTIVE',
        `questions require a begun lesson; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    const question = session.unresolvedQuestions.find((candidate) => candidate.id === input.questionId);
    if (question === undefined) {
      throw new TeachingSessionError(
        'QUESTION_NOT_FOUND',
        `no unresolved question with id "${input.questionId}" in session ${session.id}`,
        { questionId: input.questionId },
      );
    }
    if (question.resolvedAt !== null) {
      throw new TeachingSessionError(
        'QUESTION_ALREADY_RESOLVED',
        `question "${input.questionId}" is already resolved`,
        { questionId: input.questionId },
      );
    }
    const now = this.clock();
    const unresolvedQuestions = session.unresolvedQuestions.map((candidate) =>
      candidate.id === input.questionId ? { ...candidate, resolvedAt: now } : candidate,
    );
    return nextSession(session, { unresolvedQuestions }, now, this.store);
  }
}
