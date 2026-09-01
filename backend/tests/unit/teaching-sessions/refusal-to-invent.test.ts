import { describe, it, expect } from 'vitest';
import { deriveLessonFromIrDocument } from '../../../src/teaching-sessions/index.js';
import { buildLinearDocument, buildSupportTriageDocument, clone } from './helpers.js';
import type { TeachingFact, WorkflowIrDocument } from '../../../src/teaching-sessions/index.js';
import type { WorkflowNode } from '../../../src/workflow-ir/index.js';

/**
 * V2-006 — REFUSAL TO INVENT (required regression).
 *
 * The teaching model (spec/architecture/v2/workflow-teaching-and-marketplace.md)
 * and constitution §8 are explicit: "The system must disclose uncertainty
 * rather than inventing missing procedure details" and "must not invent
 * procedural facts that are not present in the workflow or evidence".
 *
 * This battery proves the derived lesson is mechanically traceable to the
 * WorkflowIR: every teaching FACT is a verbatim IR value, every missing fact
 * produces a typed NOT_SPECIFIED_BY_WORKFLOW disclosure, and every rendered
 * sentence is a fixed template over those facts (never free prose).
 */

/** The fact kinds whose values MUST be verbatim IR strings. */
const VERBATIM_FACT_KINDS: ReadonlySet<string> = new Set([
  'execution_class',
  'capability',
  'task',
  'human_kind',
  'human_instruction',
  'decision_options',
  'provided_port',
  'output_port',
  'placement',
  'completion_evidence',
]);

/** Recursively collect every string value in the IR semantic object. */
function collectIrStrings(value: unknown, collected: Set<string>): void {
  if (typeof value === 'string') collected.add(value);
  else if (Array.isArray(value)) for (const item of value) collectIrStrings(item, collected);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectIrStrings(item, collected);
  }
}

/**
 * The closed template vocabulary: after removing every verbatim IR string,
 * every remaining word of a rendered explanation/statement must be one of
 * these FIXED template function words — never new factual prose.
 */
const TEMPLATE_VOCABULARY: ReadonlySet<string> = new Set([
  'This', 'workflow', 'starts', 'at', 'step', 'takes', 'declared', 'input(s)', 'and',
  'produces', 'output(s)', 'its', 'provenance', 'origin', 'is', 'The', 'does', 'not',
  'declare', 'goal', 'in', 'natural', 'language', 'Run', 'Runs', 'after', 'outcome',
  'of', 'Step', 'executes', 'the', 'canonical', 'capability', 'as', 'executed',
  'agentic_computer_use', 'deterministic_api', 'subworkflow', 'with', 'task', 'a',
  'human', 'instruction', 'invokes', 'at', 'version', 'reference', 'Its', 'placement',
  'failure', 'policy', 'completion', 'established', 'by', 'human-readable', 'rationale',
  'for', 'this', 'what', 'referenced', 'does', 'person', 'selects', 'one', 'options',
  'provides', 'how', '(declared)', 'none',
]);

/** Strip IR strings + digits + punctuation; every remaining word must be template vocabulary. */
function assertOnlyTemplateProse(text: string, irStrings: ReadonlySet<string>): void {
  let residue = text;
  for (const irString of [...irStrings].sort((a, b) => b.length - a.length)) {
    residue = residue.split(irString).join('§');
  }
  residue = residue.replace(/[0-9]/g, ' ');
  const words = residue
    .split(/[^A-Za-z()-]+/)
    .filter((word) => word.length > 0);
  const foreign = words.filter((word) => !TEMPLATE_VOCABULARY.has(word));
  expect(
    foreign,
    `non-template (potentially invented) words in rendered teaching text: ${foreign.join(' | ')}`,
  ).toEqual([]);
}

describe('V2-006 — every teaching fact is a verbatim IR value (no invented facts)', () => {
  it('each verbatim-kinded fact value appears verbatim in the pinned IR', () => {
    const document = buildSupportTriageDocument();
    const irStrings = new Set<string>();
    collectIrStrings(document.ir, irStrings);
    const lesson = deriveLessonFromIrDocument(document);
    const facts: TeachingFact[] = lesson.steps.flatMap((step) => step.facts);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      if (VERBATIM_FACT_KINDS.has(fact.kind)) {
        expect(
          irStrings.has(fact.value),
          `fact ${fact.kind}="${fact.value}" (${fact.sourcePath}) is not a verbatim IR value`,
        ).toBe(true);
      }
    }
  });

  it('the subworkflow reference fact is composed only of the two declared identifiers', () => {
    const document = buildSupportTriageDocument();
    const irStrings = new Set<string>();
    collectIrStrings(document.ir, irStrings);
    const lesson = deriveLessonFromIrDocument(document);
    const fact = lesson.steps
      .flatMap((step) => step.facts)
      .find((f) => f.kind === 'subworkflow_reference')!;
    const [workflowId, versionRef] = fact.value.split('@');
    expect(irStrings.has(workflowId!)).toBe(true);
    expect(irStrings.has(versionRef!)).toBe(true);
  });
});

describe('V2-006 — missing workflow facts produce typed disclosures, never prose', () => {
  it('a deterministic_api step has NO human-readable semantics declared → typed disclosure', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const fetchTicket = lesson.steps.find((step) => step.nodeId === 'fetch_ticket')!;
    expect(
      fetchTicket.disclosures.map((d) => d.field),
    ).toEqual(['step_human_readable_semantics']);
    expect(fetchTicket.disclosures[0]!.kind).toBe('NOT_SPECIFIED_BY_WORKFLOW');
    expect(fetchTicket.disclosures[0]!.subjectPath).toBe('$.ir.nodes.fetch_ticket');
    // The explanation must end with the disclosure sentence, not a fabricated rationale.
    expect(fetchTicket.explanation).toMatch(/The workflow does not declare a human-readable rationale for this step\.$/);
  });

  it('a subworkflow step discloses BOTH missing semantics and missing completion evidence', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const escalate = lesson.steps.find((step) => step.nodeId === 'escalate_backlog')!;
    expect(escalate.disclosures.map((d) => d.field).sort()).toEqual([
      'step_completion_evidence',
      'subworkflow_semantics',
    ]);
  });

  it('steps whose semantics ARE declared carry no missing-semantics disclosure', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const draftReply = lesson.steps.find((step) => step.nodeId === 'draft_reply')!;
    expect(draftReply.disclosures).toEqual([]);
    const humanReview = lesson.steps.find((step) => step.nodeId === 'human_review')!;
    expect(humanReview.disclosures).toEqual([]);
  });

  it('the workflow-level goal is not declared → workflow_goal disclosure on the intent', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(lesson.intent.disclosures.map((d) => d.field)).toEqual(['workflow_goal']);
    expect(lesson.intent.disclosures[0]!.kind).toBe('NOT_SPECIFIED_BY_WORKFLOW');
    expect(lesson.intent.disclosures[0]!.subjectPath).toBe('$.ir');
  });

  it('the aggregated lesson disclosures contain every workflow-level + step disclosure', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const fields = lesson.disclosures.map((d) => d.field).sort();
    expect(fields).toContain('workflow_goal');
    expect(fields.filter((f) => f === 'step_human_readable_semantics')).toHaveLength(3); // fetch_ticket, send_reply, log_miss
    expect(fields.filter((f) => f === 'subworkflow_semantics')).toHaveLength(1);
    expect(fields.filter((f) => f === 'step_completion_evidence')).toHaveLength(2); // escalate_backlog, log_miss
  });

  it('disclosure EXACTNESS: declaring completionEvidence removes that disclosure', () => {
    const document = clone(buildSupportTriageDocument());
    const escalate = document.ir.nodes.find((node) => node.id === 'escalate_backlog') as WorkflowNode;
    document.ir.nodes = document.ir.nodes.map((node) =>
      node.id === escalate.id ? { ...node, completionEvidence: 'verification' } : node,
    );
    const lesson = deriveLessonFromIrDocument(document);
    const escalateStep = lesson.steps.find((step) => step.nodeId === 'escalate_backlog')!;
    expect(escalateStep.completionEvidence).toBe('verification');
    expect(escalateStep.disclosures.map((d) => d.field)).toEqual(['subworkflow_semantics']);
  });
});

describe('V2-006 — rendered explanations are fixed templates over IR facts (no free prose)', () => {
  const document = buildSupportTriageDocument();
  const irStrings = new Set<string>();
  collectIrStrings(document.ir, irStrings);

  it('every step explanation contains only template function words + verbatim IR values', () => {
    const lesson = deriveLessonFromIrDocument(document);
    for (const step of lesson.steps) {
      assertOnlyTemplateProse(step.explanation, irStrings);
    }
  });

  it('the intent statement contains only template function words + verbatim IR values', () => {
    const lesson = deriveLessonFromIrDocument(document);
    assertOnlyTemplateProse(lesson.intent.statement, irStrings);
  });

  it('the deterministic_api explanation is EXACTLY the deterministic template output', () => {
    const lesson = deriveLessonFromIrDocument(document);
    const fetchTicket = lesson.steps.find((step) => step.nodeId === 'fetch_ticket')!;
    expect(fetchTicket.explanation).toBe(
      'Step 1 (fetch_ticket) executes the canonical capability "github.repository.read" as deterministic_api. '
      + 'Its declared placement is cloud_allowed. Its declared failure policy is fail_workflow. '
      + 'Its completion is established by observation (declared). '
      + 'The workflow does not declare a human-readable rationale for this step.',
    );
  });

  it('the agentic explanation quotes the declared task verbatim', () => {
    const lesson = deriveLessonFromIrDocument(document);
    const draftReply = lesson.steps.find((step) => step.nodeId === 'draft_reply')!;
    expect(draftReply.explanation).toBe(
      'Step 2 (draft_reply) is executed as agentic_computer_use with the declared task: '
      + '"Draft a support reply and a severity classification for the ticket.". '
      + 'Its declared placement is cloud_allowed. Its declared failure policy is retry_then_fail_workflow(maxAttempts=2). '
      + 'Its completion is established by verification (declared).',
    );
  });

  it('the subworkflow explanation quotes the declared references and discloses both gaps', () => {
    const lesson = deriveLessonFromIrDocument(document);
    const escalate = lesson.steps.find((step) => step.nodeId === 'escalate_backlog')!;
    expect(escalate.explanation).toBe(
      'Runs after outcome:approved of step human_review. '
      + 'Step 4 (escalate_backlog) invokes subworkflow "wf-backlog-sync" at version reference "wfv_0192_backlog_sync_v1". '
      + 'Its declared placement is any_supported_node. Its declared failure policy is retry_then_fail_workflow(maxAttempts=3). '
      + 'The workflow does not declare what the referenced subworkflow does. '
      + 'The workflow does not declare how completion of this step is established.',
    );
  });

  it('a linear workflow with no completion evidence declared discloses it for every step', () => {
    const linear = buildLinearDocument();
    const lesson = deriveLessonFromIrDocument(linear);
    for (const step of lesson.steps) {
      expect(step.completionEvidence).toBeNull();
      expect(step.disclosures.map((d) => d.field).sort()).toEqual([
        'step_completion_evidence',
        'step_human_readable_semantics',
      ]);
    }
  });
});

describe('V2-006 — teaching is a derived view: derivation never mutates the document', () => {
  it('deriveLessonFromIrDocument leaves the input document deep-equal to its prior snapshot', () => {
    const document: WorkflowIrDocument = buildSupportTriageDocument();
    const before = JSON.stringify(document);
    deriveLessonFromIrDocument(document);
    deriveLessonFromIrDocument(document);
    expect(JSON.stringify(document)).toBe(before);
  });
});
