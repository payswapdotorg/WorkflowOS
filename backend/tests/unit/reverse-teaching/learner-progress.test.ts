import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID, EXPECTED_STEP_ORDER } from './helpers.js';
import { ReverseTeachingError, type ReverseTeachingSession } from '../../../src/reverse-teaching/index.js';

/**
 * V2-010 — the learner-progress regressions (Work Order: "learner progress",
 * "interactive lesson", "learner practice state").
 *
 * Manual steps are performed in the canonical order; out-of-order, duplicate,
 * mode-mismatched and empty-result submissions are typed rejections; the
 * finalization gate requires every step.
 */
describe('V2-010 learner progress', () => {
  const document = authorDailyFollowupDocument();

  function begunSession(): { service: ReturnType<typeof buildTestService>; session: ReverseTeachingSession } {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    return { service, session: service.beginLesson({ sessionId: session.id, document }) };
  }

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

  it('performs manual steps in canonical order and projects progress', () => {
    const { service, session } = begunSession();
    expect(session.progress.nextStepNodeId).toBe('fetch_open_tickets');
    expect(session.progress.allStepsPerformed).toBe(false);

    // step 1: system_performed → acknowledged_disclosure
    const s1 = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    expect(s1.progress.performedSteps.length).toBe(1);
    expect(s1.progress.nextStepNodeId).toBe('draft_followup');
    expect(s1.performedSteps[0]!.mode).toBe('acknowledged_disclosure');

    // step 2: agent_task + safety_gated → safety acknowledgment first
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.',
    }), 'SAFETY_ACKNOWLEDGMENT_REQUIRED');
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    const s2 = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.',
    });
    expect(s2.progress.performedSteps.length).toBe(2);
    expect(s2.progress.safetyAcknowledgedStepIds).toContain('draft_followup');

    // step 3: human_declared ordinary
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft',
      mode: 'performed', learnerResult: 'I read the drafts and approved them.',
    });
    // step 4: human_declared + safety_gated
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    const s4 = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome',
      mode: 'performed', learnerResult: 'I recorded "customer confirmed" in the spreadsheet.',
    });
    expect(s4.progress.performedSteps.length).toBe(4);
    // step 5: subworkflow_reference
    const s5 = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.',
    });
    void s5;
    // step 6: system_performed
    const s6 = service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    expect(s6.progress.allStepsPerformed).toBe(true);
    expect(s6.progress.nextStepNodeId).toBeNull();
    expect(s6.progress.performedSteps.map((p) => p.nodeId)).toEqual([...EXPECTED_STEP_ORDER]);
    expect(s6.progress.disclosureAcknowledgedStepCount).toBe(3);
  });

  it('rejects out-of-order, duplicate, unknown and not-begun steps (typed, fail-closed)', () => {
    const { service, session } = begunSession();
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft',
      mode: 'performed', learnerResult: 'skipping ahead',
    }), 'STEP_OUT_OF_ORDER');
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'not_a_step',
      mode: 'performed', learnerResult: 'x',
    }), 'STEP_NOT_IN_LESSON');
    // perform step 1 correctly, then duplicate it
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure', learnerResult: 'again',
    }), 'STEP_ALREADY_PERFORMED');
  });

  it('rejects mode mismatches against the step actionability (the execution/teaching distinction at the step level)', () => {
    const { service, session } = begunSession();
    // claiming to "perform" a system_performed step by hand is a mismatch
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'performed', learnerResult: 'I did the API call by hand?',
    }), 'MANUAL_MODE_MISMATCH');
    // perform step 1 correctly, then try to "acknowledge" a performable agent step without doing it
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'acknowledged_disclosure', learnerResult: 'skip',
    }), 'MANUAL_MODE_MISMATCH');
  });

  it('rejects an empty learner result for performed steps', () => {
    const { service, session } = begunSession();
    service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed', learnerResult: '   ',
    }), 'LEARNER_RESULT_INVALID');
  });

  it('finalize is gated on every step performed (STEPS_NOT_COMPLETE) and completes the session', () => {
    const { service, session } = begunSession();
    expectCode(() => service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID }), 'STEPS_NOT_COMPLETE');
    // perform all six steps
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup', mode: 'performed', learnerResult: 'drafted by hand' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft', mode: 'performed', learnerResult: 'approved' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome', mode: 'performed', learnerResult: 'recorded' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    const finalization = service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalization.sessionStatus).toBe('completed');
    // 3 performed by hand (draft, approve, record) + 3 disclosure-acknowledged (fetch, escalate, send) = 6 total
    expect(finalization.performedStepCount).toBe(3);
    expect(finalization.disclosureAcknowledgedStepCount).toBe(3);
    // the completed session is terminal: no further performance, pause or finalize
    expectCode(() => service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets', mode: 'acknowledged_disclosure', learnerResult: 'x' }), 'SESSION_ALREADY_COMPLETED');
    expectCode(() => service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_ALREADY_COMPLETED');
    expectCode(() => service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID }), 'SESSION_ALREADY_COMPLETED');
  });

  it('performing steps requires a begun+active lesson (typed rejections in the V2-006 guard order)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    // performManualStep guards active first (the V2-006 confirmCheckpoint order)
    expectCode(() => service.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure', learnerResult: 'x',
    }), 'SESSION_NOT_ACTIVE');
    expectCode(() => service.getLesson({ sessionId: session.id, learnerId: LEARNER_ID }), 'LESSON_NOT_BEGUN');
  });
});
