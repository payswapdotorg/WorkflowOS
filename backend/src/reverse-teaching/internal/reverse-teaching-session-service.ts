/**
 * V2-010 — the reverse-teaching session service: session lifecycle, install
 * pinning, lesson attachment, safety-gated manual performance in canonical
 * order, pause/resume and finalization.
 *
 * Determinism: ALL ids and timestamps come from the injected factories
 * (deps.idFactory / deps.clock) — zero wall clock, zero randomness, zero
 * network. State is copy-on-write: every transition constructs a NEW frozen
 * session (deep-frozen snapshot of the pinned document and derived lesson
 * included) and puts it into the injected store; nothing outside the store
 * can alias mutable state (the V2-006 discipline, verbatim).
 *
 * EXECUTION/TEACHING DISTINCTION (structural): this service creates ZERO
 * runs and imports no run concept. Manual performance records LEARNING
 * evidence only.
 */
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
  WORKFLOW_IR_OBJECT_TYPE,
} from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { TEACHING_EVIDENCE_CLASS } from '../../teaching-sessions/index.js';
import type {
  BeginReverseTeachingInput,
  CreateReverseTeachingSessionInput,
  FinalizeLessonInput,
  InstalledVersionPin,
  ManualStepPerformance,
  PerformManualStepInput,
  ReverseTeachingEvidenceRecord,
  ReverseTeachingFinalization,
  ReverseTeachingLearnerProgress,
  ReverseTeachingResumeResult,
  ReverseTeachingSession,
  ReverseTeachingSessionActionInput,
  ReverseTeachingSessionReadInput,
  ReverseTeachingSessionService,
  ReverseTeachingSessionServiceDeps,
  ReverseTeachingSessionStatus,
  ReverseTeachingStep,
  SafetyAcknowledgmentInput,
} from '../types.js';
import { ReverseTeachingError } from '../types.js';
import { deepClone, deepFreeze } from './immutable.js';
import { deriveReverseTeachingLesson } from './derivation.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** Session-learner-state guard: every operation is learner-scoped. */
function requireLearner(session: ReverseTeachingSession, actingLearnerId: string): void {
  if (typeof actingLearnerId !== 'string' || actingLearnerId.length === 0) {
    throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'a non-empty learnerId is required');
  }
  if (session.learnerId !== actingLearnerId) {
    throw new ReverseTeachingError(
      'LEARNER_NOT_AUTHORIZED',
      `learner "${actingLearnerId}" is not the learner of session ${session.id}`,
      { sessionLearnerId: session.learnerId, actingLearnerId },
    );
  }
}

/** Require the session to be in a status that permits learner progress. */
function requireActive(session: ReverseTeachingSession, operation: string): void {
  if (session.status === 'completed') {
    throw new ReverseTeachingError(
      'SESSION_ALREADY_COMPLETED',
      `${operation} is impossible: session ${session.id} is completed (terminal)`,
    );
  }
  if (session.status !== 'in_progress') {
    throw new ReverseTeachingError(
      'SESSION_NOT_ACTIVE',
      `${operation} requires an in_progress session; session ${session.id} is ${session.status}`,
      { status: session.status },
    );
  }
}

/** Project the learner progress from the session state + evidence. */
function projectProgress(session: ReverseTeachingSession): ReverseTeachingLearnerProgress {
  const lesson = session.lesson;
  const performed = [...session.performedSteps];
  const order = lesson?.stepOrder ?? [];
  const nextStepNodeId = order.find((nodeId) => !performed.some((p) => p.nodeId === nodeId)) ?? null;
  return {
    performedSteps: performed,
    nextStepNodeId,
    allStepsPerformed: lesson !== null && order.length > 0 && nextStepNodeId === null,
    safetyAcknowledgedStepIds: session.safetyAcknowledgments.map((a) => a.nodeId),
    performedStepCount: performed.filter((p) => p.mode === 'performed').length,
    disclosureAcknowledgedStepCount: performed.filter((p) => p.mode === 'acknowledged_disclosure').length,
  };
}

/** Construct the next frozen session state (copy-on-write) and persist it. */
function nextSession(
  session: ReverseTeachingSession,
  patch: Partial<ReverseTeachingSession>,
  now: number,
  store: { put(session: ReverseTeachingSession): void },
): ReverseTeachingSession {
  const merged: ReverseTeachingSession = { ...session, ...patch, updatedAt: now };
  const updated: ReverseTeachingSession = { ...merged, progress: projectProgress(merged) };
  const frozen = deepFreeze(updated);
  store.put(frozen);
  return frozen;
}

/** Validate the installed-version pin shape (fail closed). */
function validatePin(pin: InstalledVersionPin): void {
  if (typeof pin !== 'object' || pin === null) {
    throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'pin is required');
  }
  if (typeof pin.installationId !== 'string' || pin.installationId.trim().length === 0) {
    throw new ReverseTeachingError('INSTALLATION_PIN_INVALID', 'pin.installationId must be a non-empty string');
  }
  if (typeof pin.workflowId !== 'string' || pin.workflowId.length === 0) {
    throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'pin.workflowId must be a non-empty string');
  }
  if (typeof pin.versionId !== 'string' || pin.versionId.length === 0) {
    throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'pin.versionId must be a non-empty string');
  }
  const digest: WorkflowVersionSemanticDigest | undefined = pin.semanticDigest;
  if (digest === undefined || typeof digest !== 'object' || digest === null) {
    throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'pin.semanticDigest is required');
  }
  if (digest.algorithm !== 'sha-256') {
    throw new ReverseTeachingError(
      'PIN_DIGEST_ALGORITHM_UNSUPPORTED',
      `the pinned semantic digest algorithm must be sha-256 (got "${String(digest.algorithm)}")`,
      { algorithm: digest.algorithm },
    );
  }
  if (digest.domain !== WORKFLOW_IR_OBJECT_TYPE) {
    throw new ReverseTeachingError(
      'PIN_DIGEST_DOMAIN_MISMATCH',
      `the pinned semantic digest domain must be ${WORKFLOW_IR_OBJECT_TYPE} (got "${String(digest.domain)}")`,
      { domain: digest.domain },
    );
  }
  if (typeof digest.digest !== 'string' || !HEX64.test(digest.digest)) {
    throw new ReverseTeachingError(
      'REVERSE_TEACHING_INPUT_INVALID',
      'pin.semanticDigest.digest must be a 64-character lowercase hex string',
    );
  }
}

/** Verify supplied teaching content against the pinned semantic digest. */
function verifyPin(session: ReverseTeachingSession, document: WorkflowIrDocument): void {
  const computed = computeWorkflowVersionSemanticDigest(document);
  if (
    computed.domain !== session.pin.semanticDigest.domain ||
    computed.algorithm !== session.pin.semanticDigest.algorithm ||
    computed.digest !== session.pin.semanticDigest.digest
  ) {
    throw new ReverseTeachingError(
      'VERSION_PIN_MISMATCH',
      `the supplied teaching content does not match the pinned WorkflowVersion semantic digest for session ${session.id}`,
      { pinnedDigest: session.pin.semanticDigest.digest, suppliedDigest: computed.digest },
    );
  }
}

/** The expected manual mode of one reverse-teaching step. */
function expectedModeOf(step: ReverseTeachingStep): 'performed' | 'acknowledged_disclosure' {
  return step.actionability === 'system_performed' || step.actionability === 'subworkflow_reference'
    ? 'acknowledged_disclosure'
    : 'performed';
}

export class DefaultReverseTeachingSessionService implements ReverseTeachingSessionService {
  private readonly idFactory: () => string;
  private readonly clock: () => number;
  private readonly store: ReverseTeachingSessionServiceDeps['store'];

  constructor(deps: ReverseTeachingSessionServiceDeps) {
    this.idFactory = deps.idFactory;
    this.clock = deps.clock;
    this.store = deps.store;
  }

  // --------------------------------------------------------------------------

  createSession(input: CreateReverseTeachingSessionInput): ReverseTeachingSession {
    if (typeof input !== 'object' || input === null) {
      throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'the create input must be an object');
    }
    if (typeof input.learnerId !== 'string' || input.learnerId.trim().length === 0) {
      throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'learnerId must be a non-empty string');
    }
    validatePin(input.pin);
    const now = this.clock();
    const session: ReverseTeachingSession = {
      id: this.idFactory(),
      learnerId: input.learnerId,
      pin: deepFreeze(deepClone(input.pin)),
      status: 'not_started',
      createdAt: now,
      updatedAt: now,
      lesson: null,
      pinnedDocument: null,
      performedSteps: [],
      safetyAcknowledgments: [],
      evidence: [],
      progress: {
        performedSteps: [],
        nextStepNodeId: null,
        allStepsPerformed: false,
        safetyAcknowledgedStepIds: [],
        performedStepCount: 0,
        disclosureAcknowledgedStepCount: 0,
      },
    };
    this.store.put(session);
    return session;
  }

  private requireSession(sessionId: string): ReverseTeachingSession {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'sessionId must be a non-empty string');
    }
    const session = this.store.get(sessionId);
    if (session === undefined) {
      throw new ReverseTeachingError('SESSION_NOT_FOUND', `no reverse-teaching session with id "${sessionId}"`);
    }
    return session;
  }

  getSession(input: ReverseTeachingSessionReadInput): ReverseTeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    return session;
  }

  // --------------------------------------------------------------------------

  beginLesson(input: BeginReverseTeachingInput): ReverseTeachingSession {
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
      throw new ReverseTeachingError(
        'IR_DOCUMENT_INVALID',
        `the pinned teaching content is not a valid WorkflowIR document: ${summary}`,
        { issues: validation.issues },
      );
    }
    const lesson = deriveReverseTeachingLesson(input.document);
    const pinnedDocument = deepFreeze(deepClone(input.document)) as WorkflowIrDocument;
    const now = this.clock();
    const evidence: ReverseTeachingEvidenceRecord[] = [];
    return nextSession(
      session,
      { status: 'in_progress' as ReverseTeachingSessionStatus, lesson, pinnedDocument, evidence },
      now,
      this.store,
    );
  }

  getLesson(input: ReverseTeachingSessionReadInput): ReturnType<ReverseTeachingSessionService['getLesson']> {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.lesson === null) {
      throw new ReverseTeachingError('LESSON_NOT_BEGUN', `session ${session.id} has not begun a lesson yet`);
    }
    return session.lesson;
  }

  // --------------------------------------------------------------------------

  private requireStep(session: ReverseTeachingSession, nodeId: string): ReverseTeachingStep {
    const lesson = session.lesson;
    if (lesson === null) {
      throw new ReverseTeachingError('LESSON_NOT_BEGUN', `session ${session.id} has not begun a lesson yet`);
    }
    const step = lesson.steps.find((candidate) => candidate.nodeId === nodeId);
    if (step === undefined) {
      throw new ReverseTeachingError(
        'STEP_NOT_IN_LESSON',
        `step "${nodeId}" is not part of the reverse-teaching lesson of this session`,
        { nodeId },
      );
    }
    return step;
  }

  acknowledgeStepSafety(input: SafetyAcknowledgmentInput): ReverseTeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'the safety acknowledgment');
    const step = this.requireStep(session, input.nodeId);
    if (step.safety !== 'safety_gated') {
      throw new ReverseTeachingError(
        'SAFETY_ACKNOWLEDGMENT_NOT_APPLICABLE',
        `step "${input.nodeId}" is not safety-gated (its manual performance involves no sensitive capabilities)`,
        { nodeId: input.nodeId, safety: step.safety },
      );
    }
    if (session.safetyAcknowledgments.some((a) => a.nodeId === input.nodeId)) {
      throw new ReverseTeachingError(
        'SAFETY_ACKNOWLEDGMENT_ALREADY_GIVEN',
        `the safety notice of step "${input.nodeId}" has already been acknowledged`,
        { nodeId: input.nodeId },
      );
    }
    const now = this.clock();
    const safetyAcknowledgments = [
      ...session.safetyAcknowledgments,
      { nodeId: input.nodeId, acknowledgedAt: now },
    ];
    const evidence: ReverseTeachingEvidenceRecord[] = [
      ...session.evidence,
      {
        evidenceClass: TEACHING_EVIDENCE_CLASS,
        kind: 'learner_safety_acknowledgment',
        id: this.idFactory(),
        sessionId: session.id,
        learnerId: session.learnerId,
        pin: session.pin,
        recordedAt: now,
        detail: {
          nodeId: input.nodeId,
          sensitiveCapabilities: step.sensitiveCapabilities.join(','),
        },
      },
    ];
    return nextSession(session, { safetyAcknowledgments, evidence }, now, this.store);
  }

  // --------------------------------------------------------------------------

  performManualStep(input: PerformManualStepInput): ReverseTeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'the manual step performance');
    const step = this.requireStep(session, input.nodeId);
    if (session.performedSteps.some((p) => p.nodeId === input.nodeId)) {
      throw new ReverseTeachingError(
        'STEP_ALREADY_PERFORMED',
        `step "${input.nodeId}" has already been performed`,
        { nodeId: input.nodeId },
      );
    }
    const expectedNext =
      session.lesson!.stepOrder.find(
        (nodeId) => !session.performedSteps.some((p) => p.nodeId === nodeId),
      ) ?? null;
    if (input.nodeId !== expectedNext) {
      throw new ReverseTeachingError(
        'STEP_OUT_OF_ORDER',
        `step "${input.nodeId}" is out of order: the next manual step to perform is "${expectedNext}"`,
        { expectedNextNodeId: expectedNext, suppliedNodeId: input.nodeId },
      );
    }
    if (typeof input.mode !== 'string' || (input.mode !== 'performed' && input.mode !== 'acknowledged_disclosure')) {
      throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'mode must be "performed" or "acknowledged_disclosure"');
    }
    const expectedMode = expectedModeOf(step);
    if (input.mode !== expectedMode) {
      throw new ReverseTeachingError(
        'MANUAL_MODE_MISMATCH',
        `step "${input.nodeId}" (${step.actionability}) must be completed with mode "${expectedMode}", not "${input.mode}"`,
        { nodeId: input.nodeId, actionability: step.actionability, expectedMode, suppliedMode: input.mode },
      );
    }
    if (step.safety === 'safety_gated' && !session.safetyAcknowledgments.some((a) => a.nodeId === input.nodeId)) {
      throw new ReverseTeachingError(
        'SAFETY_ACKNOWLEDGMENT_REQUIRED',
        `step "${input.nodeId}" is safety-gated: acknowledge its safety notice explicitly before performing it (sensitive capabilities: ${step.sensitiveCapabilities.join(', ')})`,
        { nodeId: input.nodeId, sensitiveCapabilities: step.sensitiveCapabilities },
      );
    }
    if (typeof input.learnerResult !== 'string') {
      throw new ReverseTeachingError('REVERSE_TEACHING_INPUT_INVALID', 'learnerResult must be a string');
    }
    let learnerResult = input.learnerResult;
    if (input.mode === 'performed') {
      if (input.learnerResult.trim().length === 0) {
        throw new ReverseTeachingError(
          'LEARNER_RESULT_INVALID',
          `a performed step requires a non-empty learner result (what you did / observed)`,
          { nodeId: input.nodeId },
        );
      }
    } else {
      // the acknowledged-disclosure result references the step's own
      // uncertainty disclosures (fixed sentence — the learner acknowledges
      // exactly what the workflow cannot teach)
      if (input.learnerResult.trim().length === 0) {
        learnerResult = step.uncertainty.map((d) => d.message).join(' ');
      }
      if (learnerResult.trim().length === 0) {
        throw new ReverseTeachingError(
          'LEARNER_RESULT_INVALID',
          `an acknowledged step requires the disclosure acknowledgment (the step declares no uncertainty to acknowledge)`,
          { nodeId: input.nodeId },
        );
      }
    }

    const now = this.clock();
    const performance: ManualStepPerformance = {
      nodeId: input.nodeId,
      position: step.position,
      mode: input.mode,
      learnerResult,
      performedAt: now,
    };
    const performedSteps = [...session.performedSteps, performance];
    const evidence: ReverseTeachingEvidenceRecord[] = [
      ...session.evidence,
      {
        evidenceClass: TEACHING_EVIDENCE_CLASS,
        kind: input.mode === 'performed' ? 'learner_manual_step_performed' : 'learner_step_disclosure_acknowledged',
        id: this.idFactory(),
        sessionId: session.id,
        learnerId: session.learnerId,
        pin: session.pin,
        recordedAt: now,
        detail:
          input.mode === 'performed'
            ? { nodeId: input.nodeId, actionability: step.actionability, learnerResult }
            : { nodeId: input.nodeId, actionability: step.actionability },
      },
    ];
    return nextSession(session, { performedSteps, evidence }, now, this.store);
  }

  // --------------------------------------------------------------------------

  pauseSession(input: ReverseTeachingSessionActionInput): ReverseTeachingSession {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new ReverseTeachingError(
        'SESSION_ALREADY_COMPLETED',
        `pause is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status === 'paused') {
      throw new ReverseTeachingError('SESSION_ALREADY_PAUSED', `session ${session.id} is already paused`);
    }
    if (session.status !== 'in_progress') {
      throw new ReverseTeachingError(
        'SESSION_NOT_ACTIVE',
        `pause requires an in_progress session; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    return nextSession(session, { status: 'paused' }, this.clock(), this.store);
  }

  resumeSession(input: ReverseTeachingSessionActionInput): ReverseTeachingResumeResult {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    if (session.status === 'completed') {
      throw new ReverseTeachingError(
        'SESSION_ALREADY_COMPLETED',
        `resume is impossible: session ${session.id} is completed (terminal)`,
      );
    }
    if (session.status !== 'paused') {
      throw new ReverseTeachingError(
        'SESSION_NOT_PAUSED',
        `resume requires a paused session; session ${session.id} is ${session.status}`,
        { status: session.status },
      );
    }
    const resumed = nextSession(
      session,
      { status: 'in_progress' as ReverseTeachingSessionStatus },
      this.clock(),
      this.store,
    );
    return { session: resumed, resumeStepNodeId: resumed.progress.nextStepNodeId };
  }

  // --------------------------------------------------------------------------

  finalizeLesson(input: FinalizeLessonInput): ReverseTeachingFinalization {
    const session = this.requireSession(input.sessionId);
    requireLearner(session, input.learnerId);
    requireActive(session, 'the lesson finalization');
    if (!session.progress.allStepsPerformed) {
      throw new ReverseTeachingError(
        'STEPS_NOT_COMPLETE',
        `the manual lesson requires every step performed or disclosure-acknowledged first (next: "${session.progress.nextStepNodeId ?? 'none'}")`,
        { nextStepNodeId: session.progress.nextStepNodeId },
      );
    }
    const now = this.clock();
    const finalizationId = this.idFactory();
    const evidence: ReverseTeachingEvidenceRecord[] = [
      ...session.evidence,
      {
        evidenceClass: TEACHING_EVIDENCE_CLASS,
        kind: 'learner_manual_task_finalized',
        id: finalizationId,
        sessionId: session.id,
        learnerId: session.learnerId,
        pin: session.pin,
        recordedAt: now,
        detail: {
          performedStepCount: session.progress.performedStepCount,
          disclosureAcknowledgedStepCount: session.progress.disclosureAcknowledgedStepCount,
          totalSteps: session.lesson!.stepOrder.length,
        },
      },
    ];
    const updated = nextSession(
      session,
      { evidence, status: 'completed' as ReverseTeachingSessionStatus },
      now,
      this.store,
    );
    return {
      sessionId: updated.id,
      finalizedAt: now,
      performedStepCount: updated.progress.performedStepCount,
      disclosureAcknowledgedStepCount: updated.progress.disclosureAcknowledgedStepCount,
      evidenceCount: updated.evidence.length,
      sessionStatus: updated.status,
    };
  }
}
