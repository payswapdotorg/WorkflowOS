import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, LEARNER_ID } from './helpers.js';
import {
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
  DefaultReverseTeachingSessionService,
} from '../../../src/reverse-teaching/index.js';

/**
 * V2-010 — full-flow determinism (the V2-006 discipline): the same injected
 * deterministic sources produce byte-identical sessions, transitions and
 * evidence — zero wall clock, zero randomness.
 */
describe('V2-010 determinism', () => {
  const document = authorDailyFollowupDocument();

  function runManualLessonFlow(): string {
    const service = new DefaultReverseTeachingSessionService({
      idFactory: createSequentialIdFactory('rt'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    service.beginLesson({ sessionId: session.id, document });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup', mode: 'performed', learnerResult: 'I drafted the follow-up messages by hand.' });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    service.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft', mode: 'performed', learnerResult: 'I read the drafts and approved them.' });
    service.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome', mode: 'performed', learnerResult: 'I recorded "customer confirmed" in the spreadsheet.' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.' });
    service.performManualStep({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup', mode: 'acknowledged_disclosure', learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.' });
    const finalization = service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    const final = service.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    return JSON.stringify({ final, finalization });
  }

  it('the identical manual lesson flow run twice is byte-identical', () => {
    const first = runManualLessonFlow();
    const second = runManualLessonFlow();
    expect(second).toBe(first);
  });

  it('session ids and timestamps come only from the injected deterministic sources', () => {
    const service = new DefaultReverseTeachingSessionService({
      idFactory: createSequentialIdFactory('deterministic'),
      clock: createSteppingClock(42, 7),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    expect(session.id).toBe('deterministic_1');
    expect(session.createdAt).toBe(42);
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(begun.updatedAt).toBe(49);
  });
});
