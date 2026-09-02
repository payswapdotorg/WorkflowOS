import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID } from './helpers.js';
import { ReverseTeachingError, deriveReverseTeachingLesson } from '../../../src/reverse-teaching/index.js';

/**
 * V2-010 — the unsafe-instruction handling regressions (Work Order:
 * "unsafe instruction handling").
 *
 * A manual step whose declared capability requirements intersect the V2-008
 * computer-agent runtime's SENSITIVE set is safety-gated: the derivation
 * renders an explicit safety notice (verbatim capability names), and the
 * service REJECTS the manual performance until the learner has explicitly
 * acknowledged the notice.
 */
describe('V2-010 unsafe instruction handling', () => {
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

  it('the derivation renders a safety notice listing the sensitive capabilities VERBATIM', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const agent = lesson.steps.find((s) => s.nodeId === 'draft_followup')!;
    expect(agent.safety).toBe('safety_gated');
    expect(agent.safetyNotice).toContain('filesystem.read');
    expect(agent.safetyNotice).toContain('sensitive');
    const human = lesson.steps.find((s) => s.nodeId === 'record_outcome')!;
    expect(human.safetyNotice).toContain('spreadsheet.edit');
    // ordinary steps carry no notice
    expect(lesson.steps.find((s) => s.nodeId === 'approve_draft')!.safetyNotice).toBeNull();
  });

  it('the service rejects manual performance of a safety-gated step without an explicit acknowledgment', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.',
    }), 'SAFETY_ACKNOWLEDGMENT_REQUIRED');
    // the failed attempt did NOT perform the step
    const read = service.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(read.performedSteps.map((p) => p.nodeId)).toEqual(['fetch_open_tickets']);
  });

  it('an explicit safety acknowledgment unlocks the gated step and is itself recorded as evidence', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    const acknowledged = service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    expect(acknowledged.safetyAcknowledgments.map((a) => a.nodeId)).toEqual(['draft_followup']);
    const evidence = acknowledged.evidence.find((e) => e.kind === 'learner_safety_acknowledgment');
    expect(evidence).toBeDefined();
    expect(evidence!.detail['nodeId']).toBe('draft_followup');
    // now the performance is accepted
    const performed = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.',
    });
    expect(performed.performedSteps.map((p) => p.nodeId)).toEqual(['fetch_open_tickets', 'draft_followup']);
  });

  it('safety acknowledgment is only applicable to safety-gated steps (typed rejections)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    expectCode(() => service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft' }), 'SAFETY_ACKNOWLEDGMENT_NOT_APPLICABLE');
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    expectCode(() => service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' }), 'SAFETY_ACKNOWLEDGMENT_ALREADY_GIVEN');
    expectCode(() => service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'not_a_step' }), 'STEP_NOT_IN_LESSON');
  });

  it('the safety gate survives pause/resume (the acknowledgment is retained session state)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const resumed = service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(resumed.session.safetyAcknowledgments.map((a) => a.nodeId)).toEqual(['draft_followup']);
    const performed = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.',
    });
    expect(performed.progress.performedSteps.length).toBe(2);
  });
});
