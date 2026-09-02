import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID, INSTALLATION_ID } from './helpers.js';
import {
  REVERSE_TEACHING_EVIDENCE_KINDS,
  type ReverseTeachingEvidenceRecord,
} from '../../../src/reverse-teaching/index.js';
import { TEACHING_EVIDENCE_CLASS, TEACHING_EVIDENCE_KINDS } from '../../../src/teaching-sessions/index.js';

/**
 * V2-010 — the evidence-separation regressions (Work Order: "evidence
 * separation" + the teaching model: teaching evidence and execution evidence
 * are different evidence classes; a learner completing a lesson does not
 * create an execution record).
 *
 * Reverse-teaching evidence is TEACHING evidence (V2-006's class value,
 * composed) with reverse-specific kinds; it is specific to an installed
 * WorkflowVersion (the pin on every record) and structurally disjoint from
 * every execution-evidence concept.
 */
describe('V2-010 evidence separation', () => {
  const document = authorDailyFollowupDocument();

  function runFullManualLesson() {
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
    service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    return service.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
  }

  it('every evidence record carries the TEACHING class value (composed from V2-006, never redefined)', () => {
    const session = runFullManualLesson();
    expect(session.evidence.length).toBeGreaterThan(0);
    for (const record of session.evidence) {
      expect(record.evidenceClass).toBe(TEACHING_EVIDENCE_CLASS);
      expect(record.evidenceClass).toBe('teaching');
    }
  });

  it('the reverse-teaching kinds are disjoint from V2-006 session kinds and from execution concepts', () => {
    for (const kind of REVERSE_TEACHING_EVIDENCE_KINDS) {
      expect(TEACHING_EVIDENCE_KINDS).not.toContain(kind);
      // never an execution-evidence concept
      expect(kind).not.toMatch(/execution|run|step_completed|invocation|attestation/i);
    }
  });

  it('every evidence record is specific to the installed WorkflowVersion (the pin is carried)', () => {
    const session = runFullManualLesson();
    for (const record of session.evidence) {
      expect(record.pin.installationId).toBe(INSTALLATION_ID);
      expect(record.pin.workflowId).toBe(session.pin.workflowId);
      expect(record.pin.versionId).toBe(session.pin.versionId);
      expect(record.pin.semanticDigest.digest).toBe(session.pin.semanticDigest.digest);
      expect(record.sessionId).toBe(session.id);
      expect(record.learnerId).toBe(LEARNER_ID);
      expect(typeof record.recordedAt).toBe('number');
    }
  });

  it('the full manual lesson produces every reverse evidence kind (learning facts only)', () => {
    const session = runFullManualLesson();
    const kinds = new Set(session.evidence.map((r) => r.kind));
    expect(kinds).toEqual(new Set(REVERSE_TEACHING_EVIDENCE_KINDS));
    // counts: 2 safety acks + 3 performed + 3 disclosure acks + 1 finalization
    expect(session.evidence.filter((r) => r.kind === 'learner_manual_step_performed').length).toBe(3);
    expect(session.evidence.filter((r) => r.kind === 'learner_step_disclosure_acknowledged').length).toBe(3);
    expect(session.evidence.filter((r) => r.kind === 'learner_safety_acknowledgment').length).toBe(2);
    expect(session.evidence.filter((r) => r.kind === 'learner_manual_task_finalized').length).toBe(1);
  });

  it('evidence records are structurally free of run/execution concepts (no runId, no execution evidence class)', () => {
    const session = runFullManualLesson();
    const record: ReverseTeachingEvidenceRecord = session.evidence[0]!;
    const keys = Object.keys(record);
    expect(keys).not.toContain('runId');
    expect(keys).not.toContain('executionId');
    expect(keys).not.toContain('attemptId');
    const detailKeys = Object.keys(record.detail);
    for (const key of detailKeys) {
      expect(key).not.toMatch(/^(run|execution|attempt)/i);
    }
    // the detail values are JSON-safe scalars only
    for (const value of Object.values(record.detail)) {
      expect(value === null ? 'null' : typeof value).toMatch(/^(string|number|boolean|null)$/);
    }
  });
});
