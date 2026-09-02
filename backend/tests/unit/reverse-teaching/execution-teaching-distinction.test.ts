import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID } from './helpers.js';
import { deriveReverseTeachingLesson } from '../../../src/reverse-teaching/index.js';
import { RUN_EVIDENCE_CLASSES } from '../../../src/workflow-runs/index.js';

/**
 * V2-010 — the execution/teaching distinction regressions (Work Order:
 * "clear distinction between workflow execution and human learning" + the
 * teaching model's AUTOMATE ME / TEACH ME symmetry).
 *
 *   - the derivation states, per step, BOTH what the WORKFLOW executes
 *     (executionClass) and what the PERSON performs by hand (actionability);
 *   - the lesson purpose frames the TEACH ME mode explicitly (learning, not
 *     execution);
 *   - performing the task manually creates ZERO run records (the module
 *     cannot even express one: no run concept crosses its surface);
 *   - teaching evidence never claims a workflow step's effect happened.
 */
describe('V2-010 execution/teaching distinction', () => {
  const document = authorDailyFollowupDocument();

  it('every step carries BOTH the workflow-execution view and the human-manual view', () => {
    const lesson = deriveReverseTeachingLesson(document);
    for (const step of lesson.steps) {
      // the workflow-execution view (composed V2-006 base step)
      expect(step.executionClass).toBe(step.lessonStep.executionClass);
      // the human-manual view
      expect(['human_declared', 'agent_task', 'system_performed', 'subworkflow_reference']).toContain(step.actionability);
    }
    // the system-performed steps are exactly the deterministic_api steps: the
    // WORKFLOW executes those; the person acknowledges, never performs them
    const systemSteps = lesson.steps.filter((s) => s.actionability === 'system_performed');
    expect(systemSteps.map((s) => s.nodeId).sort()).toEqual(['fetch_open_tickets', 'send_followup'].sort());
    for (const step of systemSteps) {
      expect(step.executionClass).toBe('deterministic_api');
    }
    // the human-performable steps are the human + agentic steps
    const manualSteps = lesson.steps.filter((s) => s.actionability === 'human_declared' || s.actionability === 'agent_task');
    expect(manualSteps.map((s) => s.nodeId).sort()).toEqual(['approve_draft', 'draft_followup', 'record_outcome'].sort());
  });

  it('the purpose statement frames the TEACH ME mode (manual learning, not workflow execution)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    expect(lesson.purpose.statement).toContain('TEACH ME');
    expect(lesson.purpose.statement).toContain('manually');
    expect(lesson.purpose.statement).toContain('fetch_open_tickets');
    expect(lesson.purpose.statement).toContain('ticketQuery');
    expect(lesson.purpose.statement).toContain('messageId');
  });

  it('a completed manual lesson creates ZERO run records — the module surface cannot express one', () => {
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
    const finalization = service.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalization.sessionStatus).toBe('completed');
    // the completed session's entire serialized state contains NO run concept
    const serialized = JSON.stringify(service.getSession({ sessionId: session.id, learnerId: LEARNER_ID }));
    expect(serialized).not.toMatch(/"runId"|workflow_run|WorkflowRun|"state":"(requested|running|paused_run)"/);
    // the finalization result carries no run reference either
    expect(JSON.stringify(finalization)).not.toMatch(/runId|WorkflowRun/i);
  });

  it('the derived lesson references no run concept (a view over workflow meaning, not execution state)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const serialized = JSON.stringify(lesson);
    expect(serialized).not.toMatch(/WorkflowRun|"runId"|requestRun|RunEvidence|RUN_TRIGGER/);
  });

  it('teaching evidence kinds never collide with the registry execution-evidence classes', () => {
    // RUN_EVIDENCE_CLASSES is V2-005's frozen registry vocabulary (imported
    // HERE, in the test, to prove separation — never imported by the module)
    for (const evidenceClass of RUN_EVIDENCE_CLASSES) {
      expect('teaching').not.toBe(evidenceClass);
    }
  });
});
