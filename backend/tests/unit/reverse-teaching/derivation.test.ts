import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, EXPECTED_STEP_ORDER, EXPECTED_SAFETY, assertConsumedSensitivityExpectations } from './helpers.js';
import { deriveReverseTeachingLesson } from '../../../src/reverse-teaching/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-010 — the reverse-teaching derivation regressions (Work Order:
 * "knowledge extraction determinism").
 *
 * The derivation extracts purpose, prerequisites, inputs, steps, decision
 * points and expected outcomes as a deterministic VIEW over the pinned
 * document, composed over the merged V2-006 lesson derivation — identical
 * input document → byte-identical extraction, order-independent.
 */
describe('V2-010 derivation — extraction and determinism', () => {
  assertConsumedSensitivityExpectations();
  const document = authorDailyFollowupDocument();

  it('extracts the full required surface: purpose, prerequisites, inputs, steps, decision points, expected outcomes', () => {
    const lesson = deriveReverseTeachingLesson(document);
    // purpose
    expect(lesson.purpose.intent.inputNames).toEqual(['ticketQuery']);
    expect(lesson.purpose.intent.outputNames).toEqual(['messageId']);
    expect(lesson.purpose.statement).toContain('fetch_open_tickets');
    expect(lesson.purpose.statement).toContain('ticketQuery');
    // prerequisites (composed from the V2-006 base lesson)
    expect(lesson.prerequisites.some((p) => p.kind === 'workflow_input' && p.value.includes('ticketQuery'))).toBe(true);
    expect(lesson.prerequisites.some((p) => p.kind === 'required_capability' && p.value.includes('messaging.send'))).toBe(true);
    // steps
    expect(lesson.steps.map((step) => step.nodeId)).toEqual([...EXPECTED_STEP_ORDER]);
    // decision points (composed from the V2-006 base lesson — every human step:
    // the approval decision AND the information the person must provide)
    expect(lesson.decisionPoints.map((d) => d.nodeId)).toEqual(['approve_draft', 'record_outcome']);
    expect(lesson.decisionPoints[0]!.outcomes).toContain('approved');
    expect(lesson.decisionPoints[0]!.outcomes).toContain('rejected');
    // expected outcomes (workflow outputs + terminal steps + step outputs)
    expect(lesson.expectedOutcomes.some((o) => o.kind === 'workflow_output' && o.value.includes('messageId'))).toBe(true);
    expect(lesson.expectedOutcomes.some((o) => o.kind === 'terminal_step' && o.value.includes('escalate_backlog'))).toBe(true);
  });

  it('is deterministic: the same document derives a byte-identical lesson', () => {
    const a = deriveReverseTeachingLesson(authorDailyFollowupDocument());
    const b = deriveReverseTeachingLesson(authorDailyFollowupDocument());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is order-independent: shuffled node/edge arrays derive the identical lesson', () => {
    const a = deriveReverseTeachingLesson(authorDailyFollowupDocument());
    const shuffled: WorkflowIrDocument = {
      ...authorDailyFollowupDocument(),
      ir: {
        ...authorDailyFollowupDocument().ir,
        nodes: [...authorDailyFollowupDocument().ir.nodes].reverse(),
        edges: [...authorDailyFollowupDocument().ir.edges].reverse(),
      },
    };
    const b = deriveReverseTeachingLesson(shuffled);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('composes the V2-006 base lesson verbatim (no second lesson format)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    expect(lesson.base.stepOrder).toEqual([...EXPECTED_STEP_ORDER]);
    expect(lesson.stepOrder).toEqual(lesson.base.stepOrder);
    // every reverse-teaching step carries its composed base step, same position
    for (const step of lesson.steps) {
      expect(step.lessonStep.nodeId).toBe(step.nodeId);
      expect(step.lessonStep.position).toBe(step.position);
    }
  });

  it('derives the manual actionability of every execution class', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const byId = new Map(lesson.steps.map((s) => [s.nodeId, s]));
    expect(byId.get('fetch_open_tickets')!.actionability).toBe('system_performed');
    expect(byId.get('send_followup')!.actionability).toBe('system_performed');
    expect(byId.get('draft_followup')!.actionability).toBe('agent_task');
    expect(byId.get('approve_draft')!.actionability).toBe('human_declared');
    expect(byId.get('record_outcome')!.actionability).toBe('human_declared');
    expect(byId.get('escalate_backlog')!.actionability).toBe('subworkflow_reference');
  });

  it('classifies MANUAL safety exactly from the consumed V2-008 sensitive set', () => {
    const lesson = deriveReverseTeachingLesson(document);
    for (const step of lesson.steps) {
      expect(step.safety, `${step.nodeId} safety`).toBe(EXPECTED_SAFETY[step.nodeId]);
    }
    const gated = lesson.steps.find((s) => s.nodeId === 'draft_followup')!;
    expect(gated.sensitiveCapabilities).toEqual(['filesystem.read']);
    expect(gated.safetyNotice).toContain('filesystem.read');
    const humanGated = lesson.steps.find((s) => s.nodeId === 'record_outcome')!;
    expect(humanGated.sensitiveCapabilities).toEqual(['spreadsheet.edit']);
    const ordinary = lesson.steps.find((s) => s.nodeId === 'approve_draft')!;
    expect(ordinary.sensitiveCapabilities).toEqual([]);
    expect(ordinary.safetyNotice).toBeNull();
  });

  it('renders manual instructions ONLY from declared facts (fixed templates)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const byId = new Map(lesson.steps.map((s) => [s.nodeId, s]));
    // human step: the verbatim declared instruction
    expect(byId.get('approve_draft')!.manualInstruction).toBe('Approve the drafted follow-up messages before sending.');
    expect(byId.get('approve_draft')!.manualInstructionBasis).toBe('declared_human_instruction');
    // agentic step: the declared task
    expect(byId.get('draft_followup')!.manualInstruction).toBe('Draft a follow-up message for each open ticket in the fetched list.');
    expect(byId.get('draft_followup')!.manualInstructionBasis).toBe('declared_agent_task');
    // deterministic_api step: the canonical capability name ONLY
    expect(byId.get('fetch_open_tickets')!.manualInstruction).toBe('github.repository.read');
    expect(byId.get('fetch_open_tickets')!.manualInstructionBasis).toBe('declared_capability_name');
    // subworkflow step: the declared reference
    expect(byId.get('escalate_backlog')!.manualInstruction).toBe('wf-backlog-sync@wfv_0192_backlog_sync_v1');
    expect(byId.get('escalate_backlog')!.manualInstructionBasis).toBe('declared_subworkflow_reference');
  });
});
