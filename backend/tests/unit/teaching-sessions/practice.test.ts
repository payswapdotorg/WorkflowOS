import { describe, it, expect } from 'vitest';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  LEARNER_A,
  SUPPORT_TRIAGE_STEP_SEMANTICS,
} from './helpers.js';

/**
 * V2-006 — practice questions (optional human practice).
 *
 * Questions are derived from the workflow's OWN declared facts: options are
 * the declared semantics of the workflow's own steps (never invented
 * distractors), and the expected answer is never exposed to the learner.
 */
const setup = () => {
  const service = buildService();
  const document = buildSupportTriageDocument();
  const pinned = {
    workflowId: 'wf-support-triage',
    versionId: 'wfv_triage_1',
    semanticDigest: { ...pinLinearDocument(document).semanticDigest },
  };
  const session = service.createSession({ learnerId: LEARNER_A, pinned });
  service.beginLesson({ sessionId: session.id, document });
  return { service, sessionId: session.id };
};

describe('V2-006 — practice question derivation', () => {
  it('one question per lesson step, ids deterministic', () => {
    const { service, sessionId } = setup();
    const questions = service.listPracticeQuestions({ sessionId, learnerId: LEARNER_A });
    expect(questions).toHaveLength(6);
    expect(questions.map((q) => q.nodeId)).toEqual([
      'fetch_ticket',
      'draft_reply',
      'human_review',
      'escalate_backlog',
      'log_miss',
      'send_reply',
    ]);
    expect(questions.map((q) => q.id)).toEqual([
      'pq-fetch_ticket',
      'pq-draft_reply',
      'pq-human_review',
      'pq-escalate_backlog',
      'pq-log_miss',
      'pq-send_reply',
    ]);
  });

  it('options are ONLY the declared semantics of the workflow own steps (no invented distractors)', () => {
    const { service, sessionId } = setup();
    const questions = service.listPracticeQuestions({ sessionId, learnerId: LEARNER_A });
    const declaredSemantics = new Set(Object.values(SUPPORT_TRIAGE_STEP_SEMANTICS));
    for (const question of questions) {
      expect(question.options.length).toBeGreaterThan(0);
      for (const option of question.options) {
        expect(declaredSemantics.has(option)).toBe(true);
      }
    }
  });

  it('the question payload never leaks the expected answer', () => {
    const { service, sessionId } = setup();
    const questions = service.listPracticeQuestions({ sessionId, learnerId: LEARNER_A });
    for (const question of questions) {
      const serialized = JSON.stringify(question);
      expect(serialized).not.toMatch(/"correct"/);
      expect(serialized).not.toMatch(/"expected"/);
      expect(serialized).not.toMatch(/"answer"/);
    }
  });
});

describe('V2-006 — practice is OPTIONAL: a session can complete without any practice attempt', () => {
  it('teaching without practice still reaches completed', () => {
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
    const assessment = service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
    });
    expect(assessment.passed).toBe(true);
    const final = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(final.status).toBe('completed');
    expect(final.progress.practiceAttemptCount).toBe(0);
    expect(final.evidence.filter((e) => e.kind === 'learner_practice_attempt')).toHaveLength(0);
  });
});
