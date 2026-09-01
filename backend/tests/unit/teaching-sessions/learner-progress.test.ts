import { describe, it, expect } from 'vitest';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  buildLinearDocument,
  LEARNER_A,
  LEARNER_B,
  SUPPORT_TRIAGE_STEP_SEMANTICS,
} from './helpers.js';

/**
 * V2-006 — LEARNER PROGRESS + LEARNER-STATE ISOLATION (required regressions).
 *
 * Per-learner progress is a state machine driven by explicit checkpoint
 * confirmations; two learners teaching the SAME pinned workflow version never
 * see or advance each other's progress, and one learner's confirmation is
 * rejected for another.
 */

describe('V2-006 — per-learner progress', () => {
  it('progress advances one checkpoint at a time, in lesson order', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });

    let current = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(current.progress.nextCheckpointNodeId).toBe('observe_page');
    expect(current.progress.allCheckpointsConfirmed).toBe(false);

    current = service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });
    expect(current.progress.confirmedCheckpoints).toHaveLength(1);
    expect(current.progress.confirmedCheckpoints[0]).toMatchObject({
      nodeId: 'observe_page',
      position: 1,
    });
    expect(current.progress.nextCheckpointNodeId).toBe('announce');

    current = service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'announce' });
    expect(current.progress.allCheckpointsConfirmed).toBe(true);
    expect(current.progress.nextCheckpointNodeId).toBeNull();
  });

  it('each confirmation records learner checkpoint-confirmation evidence with the injected clock', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });
    const current = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    const confirmations = current.evidence.filter((e) => e.kind === 'learner_checkpoint_confirmation');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.learnerId).toBe(LEARNER_A);
    expect(confirmations[0]!.recordedAt).toBeGreaterThan(0);
  });

  it('progress carries derived practice and assessment counters', () => {
    const service = buildService();
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    service.attemptPractice({
      sessionId: session.id,
      learnerId: LEARNER_A,
      nodeId: 'fetch_ticket',
      answer: 'github.repository.read',
    });
    service.attemptPractice({
      sessionId: session.id,
      learnerId: LEARNER_A,
      nodeId: 'fetch_ticket',
      answer: 'messaging.send',
    });
    const current = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(current.progress.practiceAttemptCount).toBe(2);
    expect(current.progress.correctPracticeAttemptCount).toBe(1);
  });
});

describe('V2-006 — learner-state isolation (two learners, same pinned version)', () => {
  const setupTwoLearners = () => {
    const service = buildService();
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const sessionA = service.createSession({ learnerId: LEARNER_A, pinned });
    const sessionB = service.createSession({ learnerId: LEARNER_B, pinned });
    service.beginLesson({ sessionId: sessionA.id, document });
    service.beginLesson({ sessionId: sessionB.id, document });
    return { service, sessionIdA: sessionA.id, sessionIdB: sessionB.id, document };
  };

  it('the two learners advance INDEPENDENTLY on the same pinned version', () => {
    const { service, sessionIdA, sessionIdB } = setupTwoLearners();
    // Learner A confirms two checkpoints.
    service.confirmCheckpoint({ sessionId: sessionIdA, learnerId: LEARNER_A, nodeId: 'fetch_ticket' });
    service.confirmCheckpoint({ sessionId: sessionIdA, learnerId: LEARNER_A, nodeId: 'draft_reply' });
    // Learner B confirms only one.
    service.confirmCheckpoint({ sessionId: sessionIdB, learnerId: LEARNER_B, nodeId: 'fetch_ticket' });

    const a = service.getSession({ sessionId: sessionIdA, learnerId: LEARNER_A });
    const b = service.getSession({ sessionId: sessionIdB, learnerId: LEARNER_B });
    expect(a.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket', 'draft_reply']);
    expect(b.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket']);
    expect(a.evidence).toHaveLength(2);
    expect(b.evidence).toHaveLength(1);
    // B's next checkpoint is unaffected by A's progress.
    expect(b.progress.nextCheckpointNodeId).toBe('draft_reply');
  });

  it('one learner cannot confirm on the session of the OTHER learner (LEARNER_NOT_AUTHORIZED)', () => {
    const { service, sessionIdA } = setupTwoLearners();
    expect(() =>
      service.confirmCheckpoint({ sessionId: sessionIdA, learnerId: LEARNER_B, nodeId: 'fetch_ticket' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    // A's progress is untouched by B's rejected attempt.
    const a = service.getSession({ sessionId: sessionIdA, learnerId: LEARNER_A });
    expect(a.progress.confirmedCheckpoints).toEqual([]);
  });

  it('a foreign learner cannot READ the session, lesson or questions of another learner', () => {
    const { service, sessionIdA } = setupTwoLearners();
    service.confirmCheckpoint({ sessionId: sessionIdA, learnerId: LEARNER_A, nodeId: 'fetch_ticket' });
    expect(() => service.getSession({ sessionId: sessionIdA, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() => service.getLesson({ sessionId: sessionIdA, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() =>
      service.listPracticeQuestions({ sessionId: sessionIdA, learnerId: LEARNER_B }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() =>
      service.pauseSession({ sessionId: sessionIdA, learnerId: LEARNER_B }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() =>
      service.raiseQuestion({ sessionId: sessionIdA, learnerId: LEARNER_B, question: 'hi?' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
  });

  it('the same learner may hold multiple independent sessions on the same version', () => {
    const { service, document } = setupTwoLearners();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const second = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: second.id, document });
    service.confirmCheckpoint({ sessionId: second.id, learnerId: LEARNER_A, nodeId: 'fetch_ticket' });
    expect(second.id).not.toBe('');
    // The second session has exactly its own single confirmation.
    const secondState = service.getSession({ sessionId: second.id, learnerId: LEARNER_A });
    expect(secondState.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket']);
  });

  it('learner B completing their session does not complete the session of learner A', () => {
    const { service, sessionIdA, sessionIdB, document } = setupTwoLearners();
    const lesson = service.getLesson({ sessionId: sessionIdB, learnerId: LEARNER_B });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: sessionIdB, learnerId: LEARNER_B, nodeId: step.nodeId });
    }
    const assessment = service.submitIndependentPerformance({
      sessionId: sessionIdB,
      learnerId: LEARNER_B,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
    });
    expect(assessment.passed).toBe(true);
    const a = service.getSession({ sessionId: sessionIdA, learnerId: LEARNER_A });
    expect(a.status).toBe('in_progress');
    expect(document.ir.nodes.length).toBe(6);
  });
});
