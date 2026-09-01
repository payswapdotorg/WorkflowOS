import { describe, it, expect } from 'vitest';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  buildLinearDocument,
  LEARNER_A,
  CLOCK_BASE_MS,
  CLOCK_STEP_MS,
  SUPPORT_TRIAGE_STEP_SEMANTICS,
} from './helpers.js';
import {
  createSequentialIdFactory,
  createSteppingClock,
  InMemoryTeachingSessionStore,
  DefaultTeachingSessionService,
} from '../../../src/teaching-sessions/index.js';
import { deriveLessonFromIrDocument } from '../../../src/teaching-sessions/index.js';

/**
 * V2-006 — DETERMINISM.
 *
 * All identity and time come from injected sources: with identical inputs and
 * identical factories, two independent service instances produce byte-identical
 * session states (ids, clock stamps, evidence order). The injected factories
 * themselves are pure and reusable.
 */

describe('V2-006 — identical inputs + identical injected sources → identical sessions', () => {
  const runFlow = () => {
    const service = new DefaultTeachingSessionService({
      idFactory: createSequentialIdFactory('ts'),
      clock: createSteppingClock(CLOCK_BASE_MS, CLOCK_STEP_MS),
      store: new InMemoryTeachingSessionStore(),
    });
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    service.attemptPractice({
      sessionId: session.id,
      learnerId: LEARNER_A,
      nodeId: 'fetch_ticket',
      answer: 'messaging.send',
    });
    service.pauseSession({ sessionId: session.id, learnerId: LEARNER_A });
    service.resumeSession({ sessionId: session.id, learnerId: LEARNER_A });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    const assessment = service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
    });
    return {
      finalSession: JSON.stringify(service.getSession({ sessionId: session.id, learnerId: LEARNER_A })),
      assessment: JSON.stringify(assessment),
      questions: JSON.stringify(service.listPracticeQuestions({ sessionId: session.id, learnerId: LEARNER_A })),
    };
  };

  it('two independent runs are byte-identical', () => {
    const first = runFlow();
    const second = runFlow();
    expect(first.finalSession).toBe(second.finalSession);
    expect(first.assessment).toBe(second.assessment);
    expect(first.questions).toBe(second.questions);
  });

  it('the deterministic clock stamps are sequential from the injected base', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    expect(session.createdAt).toBe(CLOCK_BASE_MS);
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(begun.updatedAt).toBe(CLOCK_BASE_MS + CLOCK_STEP_MS);
    const confirmed = service.confirmCheckpoint({
      sessionId: session.id,
      learnerId: LEARNER_A,
      nodeId: 'observe_page',
    });
    expect(confirmed.progress.confirmedCheckpoints[0]!.confirmedAt).toBe(CLOCK_BASE_MS + 2 * CLOCK_STEP_MS);
    expect(confirmed.evidence[0]!.recordedAt).toBe(CLOCK_BASE_MS + 2 * CLOCK_STEP_MS);
  });
});

describe('V2-006 — the derived lesson is a pure deterministic projection', () => {
  it('the lesson JSON is byte-identical across derivations and services', () => {
    const a = JSON.stringify(deriveLessonFromIrDocument(buildSupportTriageDocument()));
    const b = JSON.stringify(deriveLessonFromIrDocument(buildSupportTriageDocument()));
    expect(a).toBe(b);
  });

  it('key order is canonical: two separately-built identical documents give the same lesson JSON', () => {
    const document = buildSupportTriageDocument();
    const reordered: typeof document = {
      ir: {
        ...document.ir,
        nodes: [...document.ir.nodes].reverse(),
        edges: [...document.ir.edges].reverse(),
        inputs: [...document.ir.inputs].reverse(),
      },
      compatibility: document.compatibility,
      irSchemaVersion: document.irSchemaVersion,
      objectType: document.objectType,
    };
    expect(JSON.stringify(deriveLessonFromIrDocument(reordered))).toBe(
      JSON.stringify(deriveLessonFromIrDocument(buildSupportTriageDocument())),
    );
  });
});
