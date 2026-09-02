import { describe, it, expect } from 'vitest';
import {
  canonicalSemanticJson,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  buildLinearDocument,
  clone,
  LEARNER_A,
  LEARNER_B,
  SUPPORT_TRIAGE_STEP_SEMANTICS,
} from './helpers.js';

/**
 * V2-006 — NO MUTATION OF THE INSTALLED WORKFLOW (required regression).
 *
 * Teaching is a derived VIEW: the session deep-freezes a snapshot of the
 * pinned document at begin time, every teaching operation reads it, and no
 * API writes back to any workflow surface. The caller's original object, the
 * stored snapshot and the pinned semantic digest all remain byte-identical
 * through a full teaching flow.
 */

describe('V2-006 — a full teaching flow never mutates the source document', () => {
  it('the caller document object is deep-equal before and after the entire flow', () => {
    const service = buildService();
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const before = JSON.stringify(document);

    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_A });
    service.attemptPractice({
      sessionId: session.id,
      learnerId: LEARNER_A,
      nodeId: 'fetch_ticket',
      answer: 'messaging.send',
    });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: step.nodeId });
    }
    service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_A,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
    });

    expect(JSON.stringify(document)).toBe(before);
    // And the pinned digest still matches the (unchanged) document.
    const final = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(computeWorkflowVersionSemanticDigest(document).digest).toBe(final.pinned.semanticDigest.digest);
  });

  it('mutating the CALLER document after begin does not affect the session snapshot', () => {
    const service = buildService();
    const document = clone(buildSupportTriageDocument());
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(buildSupportTriageDocument()).semanticDigest },
    };
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });

    // Tamper with the caller-side object (the session holds its own frozen snapshot).
    const mutable = document as unknown as { ir: { start: string; nodes: { id: string; spec: unknown }[] } };
    mutable.ir.start = 'log_miss';
    mutable.ir.nodes[0]!.spec = { class: 'deterministic_api', capability: 'filesystem.write' };

    const stored = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(stored.pinnedDocument!.ir.start).toBe('fetch_ticket');
    expect(stored.lesson!.stepOrder[0]).toBe('fetch_ticket');
  });

  it('the stored snapshot is FROZEN: attempts to mutate it throw (fail closed)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    const stored = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(() => {
      (stored.pinnedDocument as { ir: { start: string } }).ir.start = 'tampered';
    }).toThrowError();
    expect(() => {
      (stored.lesson as unknown as { stepOrder: string[] }).stepOrder.push('ghost');
    }).toThrowError();
    const still = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(still.pinnedDocument!.ir.start).toBe('observe_page');
    expect(still.lesson!.stepOrder).toEqual(['observe_page', 'announce']);
  });

  it('the returned session objects are snapshots: mutating one does not corrupt the store', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });

    const view = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(() => {
      (view.progress as unknown as { confirmedCheckpoints: unknown[] }).confirmedCheckpoints.pop();
    }).toThrowError();
    const again = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(again.progress.confirmedCheckpoints).toHaveLength(1);
  });

  it('the semantic canonical JSON of the pinned document is byte-stable across the whole flow', () => {
    const service = buildService();
    const document = buildSupportTriageDocument();
    const pinned = {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: { ...pinLinearDocument(document).semanticDigest },
    };
    const canonicalBefore = canonicalSemanticJson(document);
    const session = service.createSession({ learnerId: LEARNER_B, pinned });
    service.beginLesson({ sessionId: session.id, document });
    const lesson = service.getLesson({ sessionId: session.id, learnerId: LEARNER_B });
    for (const step of lesson.steps) {
      service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_B, nodeId: step.nodeId });
    }
    service.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: LEARNER_B,
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
    });
    const final = service.getSession({ sessionId: session.id, learnerId: LEARNER_B });
    expect(canonicalSemanticJson(final.pinnedDocument!)).toBe(canonicalBefore);
    expect(final.pinned.semanticDigest.digest).toBe(computeWorkflowVersionSemanticDigest(document).digest);
  });
});
