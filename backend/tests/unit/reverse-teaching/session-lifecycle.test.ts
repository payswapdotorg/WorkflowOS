import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID } from './helpers.js';
import { ReverseTeachingError } from '../../../src/reverse-teaching/index.js';

/**
 * V2-010 — the interactive-lesson lifecycle regressions (Work Order:
 * "interactive lesson with pause/resume").
 */
describe('V2-010 session lifecycle (pause/resume)', () => {
  const document = authorDailyFollowupDocument();

  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ReverseTeachingError);
      expect((error as ReverseTeachingError).code).toBe(code);
      return;
    }
    throw new Error(`expected a ReverseTeachingError with code ${code}`);
  }

  function performFirstStep(service: ReturnType<typeof buildTestService>, sessionId: string): void {
    service.performManualStep({
      sessionId, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
  }

  it('pauses an in_progress session and resumes to the EXACT pending step', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    performFirstStep(service, session.id);
    const paused = service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(paused.status).toBe('paused');
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'x',
    }), 'SESSION_NOT_ACTIVE');
    // resume returns the exact pending step
    const resumed = service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(resumed.session.status).toBe('in_progress');
    expect(resumed.resumeStepNodeId).toBe('draft_followup');
    // and the performed state survived
    expect(resumed.session.progress.performedSteps.length).toBe(1);
    expect(resumed.session.performedSteps[0]!.nodeId).toBe('fetch_open_tickets');
  });

  it('double pause / double resume / pause-when-not-begun are typed rejections', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    expectCode(() => service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_NOT_ACTIVE');
    expectCode(() => service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_NOT_PAUSED');
    service.beginLesson({ sessionId: session.id, document });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expectCode(() => service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_ALREADY_PAUSED');
    service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expectCode(() => service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_NOT_PAUSED');
  });

  it('resume after completing all steps reports no pending step', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    performFirstStep(service, session.id);
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup', mode: 'performed', learnerResult: 'drafted by hand' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft', mode: 'performed', learnerResult: 'approved' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome', mode: 'performed', learnerResult: 'recorded' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.' });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const resumed = service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(resumed.resumeStepNodeId).toBe('send_followup');
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    const finalization = service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalization.sessionStatus).toBe('completed');
    expectCode(() => service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_ALREADY_COMPLETED');
  });
});
