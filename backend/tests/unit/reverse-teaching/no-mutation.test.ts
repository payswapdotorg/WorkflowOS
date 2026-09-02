import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID } from './helpers.js';

/**
 * V2-010 — the no-mutation regressions (teaching model: "teaching sessions
 * never mutate workflow definitions implicitly"; constitution §8: derived
 * artifacts may contain learner state but never mutate the source
 * WorkflowVersion).
 */
describe('V2-010 no mutation of the installed workflow', () => {
  const document = authorDailyFollowupDocument();

  it('the full teaching flow leaves the supplied document byte-identical', () => {
    const before = JSON.stringify(document);
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup', mode: 'performed', learnerResult: 'drafted by hand' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft', mode: 'performed', learnerResult: 'approved' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome', mode: 'performed', learnerResult: 'recorded' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('the session state is deep-frozen (no external aliasing of mutable teaching state)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(Object.isFrozen(begun)).toBe(true);
    expect(Object.isFrozen(begun.pinnedDocument)).toBe(true);
    expect(Object.isFrozen(begun.lesson)).toBe(true);
    expect(Object.isFrozen(begun.performedSteps)).toBe(true);
    expect(Object.isFrozen(begun.evidence)).toBe(true);
    expect(Object.isFrozen(begun.pin)).toBe(true);
    // mutation attempts are silently ignored in strict mode... (frozen objects throw in strict TS)
    expect(() => {
      (begun as unknown as { status: string }).status = 'completed';
    }).toThrow();
  });

  it('the pinned snapshot stays byte-identical across the whole session lifetime', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    const snapshot = JSON.stringify(begun.pinnedDocument);
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    const later = service.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(JSON.stringify(later.pinnedDocument)).toBe(snapshot);
    expect(JSON.stringify(later.lesson)).toBe(JSON.stringify(begun.lesson));
  });
});
