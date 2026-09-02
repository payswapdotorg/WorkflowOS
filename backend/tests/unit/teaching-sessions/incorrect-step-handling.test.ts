import { describe, it, expect } from 'vitest';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  buildLinearDocument,
  LEARNER_A,
  snapshot,
} from './helpers.js';

/**
 * V2-006 — INCORRECT STEP HANDLING (required regression).
 *
 * Wrong checkpoint / wrong order / unknown step / duplicate confirmation are
 * typed, fail-closed rejections WITH corrective feedback, and the session
 * state is unharmed by every rejected attempt.
 */

const setupTriage = () => {
  const service = buildService();
  const document = buildSupportTriageDocument();
  const pinned = {
    workflowId: 'wf-support-triage',
    versionId: 'wfv_triage_1',
    semanticDigest: { ...pinLinearDocument(document).semanticDigest },
  };
  const session = service.createSession({ learnerId: LEARNER_A, pinned });
  service.beginLesson({ sessionId: session.id, document });
  service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'fetch_ticket' });
  return { service, sessionId: session.id };
};

describe('V2-006 — confirming a step out of order is a typed rejection with feedback', () => {
  it('skipping ahead to a later step is rejected with the expected next checkpoint', () => {
    const { service, sessionId } = setupTriage();
    const before = snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }));
    let rejection: { message: string; code?: string; details?: Record<string, unknown> } | null = null;
    try {
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'send_reply' });
    } catch (error) {
      rejection = error as { message: string; code?: string; details?: Record<string, unknown> };
    }
    expect(rejection).not.toBeNull();
    expect(rejection!.message).toMatch(/CHECKPOINT_OUT_OF_ORDER/);
    // Corrective feedback: the typed details identify the expected checkpoint.
    expect(rejection!.details).toMatchObject({ expectedNextNodeId: 'draft_reply', suppliedNodeId: 'send_reply' });
    // Session unharmed.
    expect(snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }))).toBe(before);
  });

  it('confirming a step that belongs to a CONDITIONAL branch before its gate is out of order', () => {
    const { service, sessionId } = setupTriage();
    expect(() =>
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'log_miss' }),
    ).toThrowError(/CHECKPOINT_OUT_OF_ORDER/);
  });

  it('re-confirming an already-confirmed step is rejected (CHECKPOINT_ALREADY_CONFIRMED)', () => {
    const { service, sessionId } = setupTriage();
    const before = snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }));
    expect(() =>
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'fetch_ticket' }),
    ).toThrowError(/CHECKPOINT_ALREADY_CONFIRMED/);
    expect(snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }))).toBe(before);
  });

  it('confirming a step that is not in the lesson at all is rejected (CHECKPOINT_NOT_IN_LESSON)', () => {
    const { service, sessionId } = setupTriage();
    const before = snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }));
    expect(() =>
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'not_a_real_step' }),
    ).toThrowError(/CHECKPOINT_NOT_IN_LESSON/);
    expect(snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }))).toBe(before);
  });

  it('after the typed rejection the learner can still confirm the correct next step', () => {
    const { service, sessionId } = setupTriage();
    try {
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'send_reply' });
    } catch {
      // expected typed rejection
    }
    const after = service.confirmCheckpoint({ sessionId, learnerId: LEARNER_A, nodeId: 'draft_reply' });
    expect(after.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket', 'draft_reply']);
    expect(after.progress.nextCheckpointNodeId).toBe('human_review');
  });
});

describe('V2-006 — a wrong practice answer is a typed INCORRECT outcome (not a session error)', () => {
  it('the incorrect attempt is recorded, corrected with the workflow declaration, and the session is unharmed', () => {
    const { service, sessionId } = setupTriage();

    let result: { outcome: string; feedback: string; declaredSemantic?: string } | null = null;
    try {
      result = service.attemptPractice({
        sessionId,
        learnerId: LEARNER_A,
        nodeId: 'draft_reply',
        answer: 'messaging.send',
      });
    } catch (error) {
      throw new Error(`practice must not throw on an incorrect answer: ${String(error)}`);
    }
    expect(result!.outcome).toBe('incorrect');
    // Correction quotes the workflow's OWN declared semantics (never invented).
    expect(result!.declaredSemantic).toBe(
      'Draft a support reply and a severity classification for the ticket.',
    );
    expect(result!.feedback).toContain(result!.declaredSemantic!);

    // The session changed ONLY by the practice evidence record; the
    // checkpoint progress is unharmed.
    const after = service.getSession({ sessionId, learnerId: LEARNER_A });
    expect(after.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket']);
    expect(after.progress.nextCheckpointNodeId).toBe('draft_reply');
    expect(after.progress.practiceAttemptCount).toBe(1);
    expect(after.progress.correctPracticeAttemptCount).toBe(0);
    expect(after.evidence).toHaveLength(2);
    expect(after.evidence[0]!.kind).toBe('learner_checkpoint_confirmation');
    expect(after.evidence[1]!.kind).toBe('learner_practice_attempt');
    expect(after.evidence[1]!.detail).toMatchObject({ nodeId: 'draft_reply', correct: false });
  });

  it('a correct practice answer is a typed correct outcome and increments the counters', () => {
    const { service, sessionId } = setupTriage();
    const result = service.attemptPractice({
      sessionId,
      learnerId: LEARNER_A,
      nodeId: 'draft_reply',
      answer: 'Draft a support reply and a severity classification for the ticket.',
    });
    expect(result.outcome).toBe('correct');
    expect(result.feedback).toContain('draft_reply');
    const after = service.getSession({ sessionId, learnerId: LEARNER_A });
    expect(after.progress.practiceAttemptCount).toBe(1);
    expect(after.progress.correctPracticeAttemptCount).toBe(1);
  });

  it('practice for a step not in the lesson is a typed rejection (PRACTICE_STEP_NOT_IN_LESSON)', () => {
    const { service, sessionId } = setupTriage();
    expect(() =>
      service.attemptPractice({ sessionId, learnerId: LEARNER_A, nodeId: 'nope', answer: 'x' }),
    ).toThrowError(/PRACTICE_STEP_NOT_IN_LESSON/);
  });
});

describe('V2-006 — a failed independent-performance assessment does not complete the session', () => {
  it('wrong order or wrong semantics fail the assessment; the session stays in_progress for a retry', () => {
    const service = buildService();
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    const failed = service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      // WRONG order (reversed) and one WRONG semantic.
      orderedStepIds: [...lesson.stepOrder].reverse(),
      semanticsByStep: {
        fetch_ticket: 'github.repository.read',
        draft_reply: 'wrong answer',
        human_review: 'Approve sending the drafted support reply and syncing the backlog.',
        send_reply: 'messaging.send',
        escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
        log_miss: 'filesystem.write',
      },
    });
    expect(failed.passed).toBe(false);
    expect(failed.orderCorrect).toBe(false);
    expect(failed.sessionStatus).toBe('in_progress');
    const perStep = failed.perStep.find((s) => s.nodeId === 'draft_reply')!;
    expect(perStep.semanticsCorrect).toBe(false);
    // Corrections quote the workflow's own declaration.
    expect(failed.corrections.join(' ')).toContain('Draft a support reply and a severity classification');

    // Retry with the correct submission completes the session.
    const retried = service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: {
        fetch_ticket: 'github.repository.read',
        draft_reply: 'Draft a support reply and a severity classification for the ticket.',
        human_review: 'Approve sending the drafted support reply and syncing the backlog.',
        send_reply: 'messaging.send',
        escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
        log_miss: 'filesystem.write',
      },
    });
    expect(retried.passed).toBe(true);
    expect(retried.sessionStatus).toBe('completed');
  });

  it('an assessment before all checkpoints are confirmed is rejected (CHECKPOINTS_NOT_COMPLETE)', () => {
    const { service, sessionId } = setupTriage();
    const lesson = service.getLesson({ sessionId, learnerId: LEARNER_A });
    expect(() =>
      service.submitIndependentPerformance({
        sessionId,
        learnerId: LEARNER_A,
        orderedStepIds: lesson.stepOrder,
        semanticsByStep: {},
      }),
    ).toThrowError(/CHECKPOINTS_NOT_COMPLETE/);
  });

  it('a structurally invalid assessment is rejected fail-closed (ASSESSMENT_INVALID_STRUCTURE)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    // Missing steps in the ordered list.
    expect(() =>
      service.submitIndependentPerformance({
        sessionId: session.id,
        learnerId: LEARNER_A,
        orderedStepIds: ['observe_page'],
        semanticsByStep: { observe_page: 'browser.observe' },
      }),
    ).toThrowError(/ASSESSMENT_INVALID_STRUCTURE/);
    // Unknown steps in the ordered list.
    expect(() =>
      service.submitIndependentPerformance({
        sessionId: session.id,
        learnerId: LEARNER_A,
        orderedStepIds: ['observe_page', 'ghost_step'],
        semanticsByStep: { observe_page: 'browser.observe', ghost_step: 'x' },
      }),
    ).toThrowError(/ASSESSMENT_INVALID_STRUCTURE/);
    // Missing semantics entry for a declared step.
    expect(() =>
      service.submitIndependentPerformance({
        sessionId: session.id,
        learnerId: LEARNER_A,
        orderedStepIds: lesson.stepOrder,
        semanticsByStep: { observe_page: 'browser.observe' },
      }),
    ).toThrowError(/ASSESSMENT_INVALID_STRUCTURE/);
  });
});
