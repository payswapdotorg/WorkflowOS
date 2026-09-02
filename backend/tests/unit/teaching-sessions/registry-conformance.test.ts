import { describe, it, expect } from 'vitest';
import { computeWorkflowVersionSemanticDigest } from '../../../src/workflow-ir/index.js';
import { WORKFLOW_IR_REGISTRY_VOCABULARY } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { deriveLessonFromIrDocument } from '../../../src/teaching-sessions/index.js';
import type { PinnedWorkflowVersion } from '../../../src/teaching-sessions/index.js';
import { buildSupportTriageDocument, buildLinearDocument, clone, buildService } from './helpers.js';

/**
 * V2-006 — registry discipline (V2-CTRL-003).
 *
 * Every capability name, placement id and execution class appearing in
 * teaching CONTENT is a canonical registry name carried from the validated
 * WorkflowIR (the merged V2-003 validation rejects aliases at begin time —
 * the forbidden aliases appear here ONLY as rejection fixtures, never as
 * protocol meanings).
 */
const CANONICAL_CAPABILITIES = new Set<string>(WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities);
const CANONICAL_PLACEMENTS = new Set<string>(WORKFLOW_IR_REGISTRY_VOCABULARY.placement);
const CANONICAL_EXECUTION_CLASSES = new Set<string>(WORKFLOW_IR_REGISTRY_VOCABULARY.executionClasses);

describe('V2-006 — teaching content uses only canonical registry vocabulary', () => {
  it('every capability/execution-class fact and prerequisite is a canonical registry name', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const capabilityFacts = lesson.steps
      .flatMap((step) => step.facts)
      .filter((fact) => fact.kind === 'capability');
    expect(capabilityFacts.length).toBeGreaterThanOrEqual(3);
    for (const fact of capabilityFacts) {
      expect(CANONICAL_CAPABILITIES.has(fact.value), `non-canonical capability: ${fact.value}`).toBe(true);
    }
    const capabilityPrereqs = lesson.prerequisites.filter((p) => p.kind === 'required_capability');
    for (const prerequisite of capabilityPrereqs) {
      const name = prerequisite.value.replace(/^required capability /, '');
      expect(CANONICAL_CAPABILITIES.has(name)).toBe(true);
    }
    for (const step of lesson.steps) {
      expect(CANONICAL_EXECUTION_CLASSES.has(step.executionClass)).toBe(true);
      expect(CANONICAL_PLACEMENTS.has(step.placement)).toBe(true);
      expect(CANONICAL_EXECUTION_CLASSES.has(step.semantics.class)).toBe(true);
    }
  });

  it('the quoted IR completion-evidence classes are registry evidence classes (workflow declarations)', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const evidenceFacts = lesson.steps.flatMap((step) => step.facts).filter((f) => f.kind === 'completion_evidence');
    for (const fact of evidenceFacts) {
      expect(WORKFLOW_IR_REGISTRY_VOCABULARY.evidence).toContain(fact.value);
    }
  });
});

describe('V2-006 — non-canonical aliases are rejected at begin time (workflow-ir validation)', () => {
  it('a forbidden alias capability is rejected with the merged typed validation issue', () => {
    const service = buildService();
    const base = clone(buildLinearDocument());
    const aliased: WorkflowNode = {
      ...base.ir.nodes[0]!,
      spec: { class: 'deterministic_api', capability: 'browser.observe.v2' },
      capabilityRequirements: ['browser.observe.v2'],
    };
    const document: WorkflowIrDocument = {
      ...base,
      ir: { ...base.ir, nodes: [aliased, base.ir.nodes[1]!] },
    };
    const pinned: PinnedWorkflowVersion = {
      workflowId: 'wf-alias-rejection',
      versionId: 'wfv_alias_1',
      semanticDigest: computeWorkflowVersionSemanticDigest(document),
    };
    const session = service.createSession({ learnerId: 'learner_alias', pinned });
    let rejection: { message: string } | null = null;
    try {
      service.beginLesson({ sessionId: session.id, document });
    } catch (error) {
      rejection = error as { message: string };
    }
    expect(rejection).not.toBeNull();
    expect(rejection!.message).toMatch(/IR_CAPABILITY_NON_CANONICAL|IR_CAPABILITY_REQUIREMENT_NON_CANONICAL/);
  });

  it('teaching never invents registry vocabulary the workflow does not declare', () => {
    // The linear workflow declares browser.observe + speech.synthesis only:
    // its lesson must mention exactly those capabilities and nothing else.
    const lesson = deriveLessonFromIrDocument(buildLinearDocument());
    const mentioned = new Set(
      lesson.steps
        .flatMap((step) => step.facts)
        .filter((fact) => fact.kind === 'capability')
        .map((fact) => fact.value),
    );
    expect([...mentioned].sort()).toEqual(['browser.observe', 'speech.synthesis']);
    for (const value of mentioned) {
      expect(CANONICAL_CAPABILITIES.has(value)).toBe(true);
    }
  });
});
