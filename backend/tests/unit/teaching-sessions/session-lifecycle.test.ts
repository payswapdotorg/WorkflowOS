import { describe, it, expect } from 'vitest';
import {
  buildService,
  buildLinearDocument,
  pinLinearDocument,
  LEARNER_A,
  snapshot,
} from './helpers.js';

/**
 * V2-006 — session lifecycle, PAUSE/RESUME and terminal guards (required
 * regressions: session resume; pause/resume returns to the exact checkpoint;
 * cannot resume a completed session).
 */

describe('V2-006 — the TeachingSession state machine', () => {
  it('a new session is not_started with no lesson and no evidence', () => {
    const service = buildService();
    const session = service.createSession({
      learnerId: LEARNER_A,
      pinned: pinLinearDocument(buildLinearDocument()),
    });
    expect(session.status).toBe('not_started');
    expect(session.lesson).toBeNull();
    expect(session.pinnedDocument).toBeNull();
    expect(session.progress.confirmedCheckpoints).toEqual([]);
    expect(session.progress.nextCheckpointNodeId).toBeNull();
    expect(session.evidence).toEqual([]);
    expect(session.unresolvedQuestions).toEqual([]);
  });

  it('beginLesson transitions not_started → in_progress and derives + stores the lesson', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson).not.toBeNull();
    expect(begun.pinnedDocument).not.toBeNull();
    expect(begun.progress.nextCheckpointNodeId).toBe('observe_page');
  });

  it('checkpoint confirmation BEFORE the lesson has begun is rejected (SESSION_NOT_ACTIVE)', () => {
    const service = buildService();
    const session = service.createSession({
      learnerId: LEARNER_A,
      pinned: pinLinearDocument(buildLinearDocument()),
    });
    expect(() =>
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' }),
    ).toThrowError(/SESSION_NOT_ACTIVE/);
  });

  it('getLesson before begin is rejected (LESSON_NOT_BEGUN)', () => {
    const service = buildService();
    const session = service.createSession({
      learnerId: LEARNER_A,
      pinned: pinLinearDocument(buildLinearDocument()),
    });
    expect(() => service.getLesson({ sessionId: session.id, learnerId: LEARNER_A })).toThrowError(
      /LESSON_NOT_BEGUN/,
    );
  });

  it('completing all checkpoints + passing the assessment completes the session (terminal)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    const assessment = service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: { observe_page: 'browser.observe', announce: 'speech.synthesis' },
    });
    expect(assessment.passed).toBe(true);
    expect(assessment.sessionStatus).toBe('completed');
    const final = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(final.status).toBe('completed');
    expect(final.progress.allCheckpointsConfirmed).toBe(true);
    expect(final.progress.nextCheckpointNodeId).toBeNull();
  });
});

describe('V2-006 — pause and resume return to the EXACT checkpoint', () => {
  const setup = () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });
    return { service, sessionId: session.id };
  };

  it('pause transitions in_progress → paused and freezes progress', () => {
    const { service, sessionId } = setup();
    const paused = service.pauseSession({ sessionId, learnerId: LEARNER_A });
    expect(paused.status).toBe('paused');
    expect(paused.progress.nextCheckpointNodeId).toBe('announce');
    // Confirmations while paused are rejected (the session is not active).
    expect(() =>
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'announce' }),
    ).toThrowError(/SESSION_NOT_ACTIVE/);
  });

  it('resume returns to the exact pending checkpoint and reactivates the session', () => {
    const { service, sessionId } = setup();
    service.pauseSession({ sessionId, learnerId: LEARNER_A });
    const resumed = service.resumeSession({ sessionId, learnerId: LEARNER_A });
    expect(resumed.session.status).toBe('in_progress');
    expect(resumed.resumeCheckpointNodeId).toBe('announce');
    // The learner continues EXACTLY where they paused.
    const after = service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'announce' });
    expect(after.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['observe_page', 'announce']);
  });

  it('pausing a paused session is rejected (SESSION_ALREADY_PAUSED)', () => {
    const { service, sessionId } = setup();
    service.pauseSession({ sessionId, learnerId: LEARNER_A });
    expect(() => service.pauseSession({ sessionId, learnerId: LEARNER_A })).toThrowError(
      /SESSION_ALREADY_PAUSED/,
    );
  });

  it('resuming a session that is not paused is rejected (SESSION_NOT_PAUSED)', () => {
    const { service, sessionId } = setup();
    expect(() => service.resumeSession({ sessionId, learnerId: LEARNER_A })).toThrowError(/SESSION_NOT_PAUSED/);
  });

  it('CANNOT RESUME A COMPLETED SESSION (required regression)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: { observe_page: 'browser.observe', announce: 'speech.synthesis' },
    });
    const completed = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(completed.status).toBe('completed');
    expect(() => service.resumeSession({ sessionId: session.id, learnerId: LEARNER_A })).toThrowError(
      /SESSION_ALREADY_COMPLETED/,
    );
  });

  it('completed is terminal: confirm / pause / practice / assessment all rejected', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: { observe_page: 'browser.observe', announce: 'speech.synthesis' },
    });
    const before = snapshot(service.getSession({ sessionId: session.id, learnerId: LEARNER_A }));
    expect(() =>
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' }),
    ).toThrowError(/SESSION_ALREADY_COMPLETED/);
    expect(() => service.pauseSession({ sessionId: session.id, learnerId: LEARNER_A })).toThrowError(
      /SESSION_ALREADY_COMPLETED/,
    );
    expect(() =>
      service.attemptPractice({
        sessionId: session.id,
        learnerId: LEARNER_A,
        nodeId: 'observe_page',
        answer: 'browser.observe',
      }),
    ).toThrowError(/SESSION_ALREADY_COMPLETED/);
    expect(() =>
      service.submitIndependentPerformance({
        sessionId: session.id,
        learnerId: LEARNER_A,
        orderedStepIds: lesson.stepOrder,
        semanticsByStep: { observe_page: 'browser.observe', announce: 'speech.synthesis' },
      }),
    ).toThrowError(/SESSION_ALREADY_COMPLETED/);
    expect(snapshot(service.getSession({ sessionId: session.id, learnerId: LEARNER_A }))).toBe(before);
  });
});

describe('V2-006 — unresolved learner questions are retained session state', () => {
  it('the learner can raise a question mid-lesson and resolve it; it survives pause/resume', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });

    const raised = service.raiseQuestion({
      sessionId: session.id,
      learnerId: LEARNER_A,
      question: 'Which URL formats does the observe step accept?',
    });
    expect(raised.unresolvedQuestions).toHaveLength(1);
    expect(raised.unresolvedQuestions[0]!.question).toBe(
      'Which URL formats does the observe step accept?',
    );
    expect(raised.unresolvedQuestions[0]!.resolvedAt).toBeNull();

    // The question is retained across pause + resume.
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_A });
    const resumed = service.resumeSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(resumed.session.unresolvedQuestions).toHaveLength(1);

    const resolved = service.resolveQuestion({
      sessionId: session.id,
      learnerId: LEARNER_A,
      questionId: raised.unresolvedQuestions[0]!.id,
    });
    expect(resolved.unresolvedQuestions[0]!.resolvedAt).not.toBeNull();
  });

  it('resolving an unknown or already-resolved question is a typed rejection', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    expect(() =>
      service.resolveQuestion({ sessionId: session.id, learnerId: LEARNER_A, questionId: 'ts_unknown' }),
    ).toThrowError(/QUESTION_NOT_FOUND/);
    const raised = service.raiseQuestion({
      sessionId: session.id,
      learnerId: LEARNER_A,
      question: 'What does announce do offline?',
    });
    service.resolveQuestion({
      sessionId: session.id,
      learnerId: LEARNER_A,
      questionId: raised.unresolvedQuestions[0]!.id,
    });
    expect(() =>
      service.resolveQuestion({
        sessionId: session.id,
        learnerId: LEARNER_A,
        questionId: raised.unresolvedQuestions[0]!.id,
      }),
    ).toThrowError(/QUESTION_ALREADY_RESOLVED/);
  });

  it('an empty question is rejected', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    expect(() =>
      service.raiseQuestion({ sessionId: session.id, learnerId: LEARNER_A, question: '  ' }),
    ).toThrowError(/TEACHING_INPUT_INVALID/);
  });
});
