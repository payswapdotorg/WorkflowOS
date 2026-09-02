import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument } from './helpers.js';
import { deriveReverseTeachingLesson } from '../../../src/reverse-teaching/index.js';

/**
 * V2-010 — the missing-information disclosure regressions (Work Order:
 * "uncertainty disclosure where the workflow lacks required teaching
 * context" + the teaching model's "must not invent procedural facts").
 *
 * The derivation emits typed NOT_SPECIFIED_BY_WORKFLOW disclosures for the
 * manual dimension — it never invents a manual procedure.
 */
describe('V2-010 missing-information disclosure', () => {
  const document = authorDailyFollowupDocument();

  it('discloses that deterministic_api steps declare NO manual equivalent (and never invents a procedure)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const fetchStep = lesson.steps.find((s) => s.nodeId === 'fetch_open_tickets')!;
    expect(
      fetchStep.uncertainty.some((d) => d.field === 'manual_equivalent' && d.subjectPath === '$.ir.nodes.fetch_open_tickets'),
    ).toBe(true);
    // the disclosure is a FIXED sentence, and the manual instruction stays the bare capability name
    expect(fetchStep.uncertainty.find((d) => d.field === 'manual_equivalent')!.message).toContain('does not declare');
    expect(fetchStep.manualInstruction).toBe('github.repository.read');
    // no invented procedure words anywhere in the rendered manual instruction
    expect(fetchStep.manualInstruction).not.toMatch(/open|click|navigate|visit|type|enter|browser|app\b/i);
  });

  it('discloses that subworkflow steps delegate their manual procedure to the referenced version', () => {
    const lesson = deriveReverseTeachingLesson(document);
    const sub = lesson.steps.find((s) => s.nodeId === 'escalate_backlog')!;
    expect(
      sub.uncertainty.some((d) => d.field === 'subworkflow_manual_procedure'),
    ).toBe(true);
    const disclosure = sub.uncertainty.find((d) => d.field === 'subworkflow_manual_procedure')!;
    expect(disclosure.message).toContain('wf-backlog-sync');
    expect(disclosure.subjectPath).toBe('$.ir.nodes.escalate_backlog');
  });

  it('aggregates every manual uncertainty on the lesson (the teaching context the workflow lacks)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    // 3 system_performed steps (fetch, send) — wait: fetch_open_tickets + send_followup = 2 manual_equivalent
    expect(lesson.uncertainty.filter((d) => d.field === 'manual_equivalent').length).toBe(2);
    expect(lesson.uncertainty.filter((d) => d.field === 'subworkflow_manual_procedure').length).toBe(1);
    // every step-level uncertainty is aggregated exactly once
    const stepUncertainty = lesson.steps.flatMap((s) => s.uncertainty);
    expect(lesson.uncertainty.length).toBe(stepUncertainty.length);
    for (const disclosure of stepUncertainty) {
      expect(lesson.uncertainty).toContainEqual(disclosure);
    }
  });

  it('composes the V2-006 base disclosures (workflow goal, subworkflow semantics, completion evidence)', () => {
    const lesson = deriveReverseTeachingLesson(document);
    // the workflow declares no goal → V2-006's workflow_goal disclosure is composed
    expect(lesson.base.disclosures.some((d) => d.field === 'workflow_goal')).toBe(true);
    // undeclared step completion evidence (escalate_backlog declares none)
    expect(lesson.base.disclosures.some((d) => d.field === 'step_completion_evidence' && d.subjectPath === '$.ir.nodes.escalate_backlog')).toBe(true);
  });

  it('the derivation never mutates the input document', () => {
    const before = JSON.stringify(authorDailyFollowupDocument());
    const doc = authorDailyFollowupDocument();
    deriveReverseTeachingLesson(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
