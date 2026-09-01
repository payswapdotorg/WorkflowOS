import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../../../src/workflow-compiler/index.js';
import { WORKFLOW_IR_REGISTRY_VOCABULARY, validateWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  buildUndeclaredInvokedCapabilityDocument,
  withNode,
  withNodeCapabilityRequirements,
  withNodePlacement,
  withDefaultPlacement,
  withEdge,
} from './helpers.js';

/**
 * V2-007 — capability and placement checks before execution.
 *
 * The compiler is the pre-execution gate for capability and placement
 * coherence: every compiled unit carries its canonical capability
 * requirements and its placement requirement forward, the workflow default
 * placement is carried, and contradictory placements are rejected at compile
 * time (never deferred to a silent runtime fallback — constitution §12:
 * locality is a correctness constraint).
 *
 * Vocabulary discipline: the compiler consumes the merged V2-003 registry
 * vocabulary snapshot (frozen registry identifiers — aliases forbidden).
 */

const AUTHORED = buildTriageDocument();

function okArtifact(document: WorkflowIrDocument = AUTHORED) {
  const result = compileWorkflow(document);
  if (!result.ok) throw new Error('fixture must compile');
  return result.artifact;
}

describe('V2-007 — capability requirements are carried forward per unit', () => {
  it('every unit carries the capability requirements of its source node (sorted, canonical)', () => {
    const artifact = okArtifact();
    for (const unit of artifact.plan.units) {
      const source = AUTHORED.ir.nodes.find((node) => node.id === unit.unit);
      expect([...unit.capabilityRequirements]).toEqual([...(source?.capabilityRequirements ?? [])].sort());
      for (const capability of unit.capabilityRequirements) {
        expect(WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities).toContain(capability);
      }
    }
  });

  it('a subworkflow unit carries the workflow.execute requirement', () => {
    const sync = okArtifact().plan.units.find((unit) => unit.unit === 'sync_backlog');
    expect(sync?.capabilityRequirements).toEqual(['workflow.execute']);
  });

  it('a deterministic_api unit carries its invoked capability in its requirements', () => {
    const fetch = okArtifact().plan.units.find((unit) => unit.unit === 'fetch_issue');
    expect(fetch?.spec).toEqual({ class: 'deterministic_api', capability: 'github.repository.read' });
    expect(fetch?.capabilityRequirements).toContain('github.repository.read');
  });

  it('changed capability requirements change the compiled artifact (requirements are semantics)', () => {
    const base = okArtifact();
    const widened = okArtifact(
      withNodeCapabilityRequirements(AUTHORED, 'fetch_issue', [
        'github.repository.read',
        'browser.observe',
      ]),
    );
    expect(widened.plan.units.find((unit) => unit.unit === 'fetch_issue')?.capabilityRequirements).toEqual([
      'browser.observe',
      'github.repository.read',
    ]);
    expect(widened.artifactDigest).not.toBe(base.artifactDigest);
  });
});

describe('V2-007 — placement requirements are carried forward and checked', () => {
  it('every unit carries the placement of its source node', () => {
    const artifact = okArtifact();
    for (const unit of artifact.plan.units) {
      const source = AUTHORED.ir.nodes.find((node) => node.id === unit.unit);
      expect(unit.placement).toBe(source?.placement);
    }
  });

  it('the workflow default placement is carried in the plan', () => {
    expect(okArtifact().plan.defaultPlacement).toBe('any_supported_node');
    expect(okArtifact(withDefaultPlacement(AUTHORED, 'cloud_allowed')).plan.defaultPlacement).toBe(
      'cloud_allowed',
    );
  });

  it('a changed node placement changes the compiled artifact (placement is semantics)', () => {
    const base = okArtifact();
    const moved = okArtifact(withNodePlacement(AUTHORED, 'notify_channel', 'cloud_allowed'));
    expect(moved.plan.units.find((unit) => unit.unit === 'notify_channel')?.placement).toBe(
      'cloud_allowed',
    );
    expect(moved.artifactDigest).not.toBe(base.artifactDigest);
  });

  it('locality contradictions are rejected BEFORE execution, never silently downgraded', () => {
    const conflicted = withDefaultPlacement(AUTHORED, 'device_local');
    const result = compileWorkflow(withNodePlacement(conflicted, 'notify_channel', 'cloud_required'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT')).toBe(true);
    }
  });
});

describe('V2-007 — deterministic plan order and control semantics (inspectable plan)', () => {
  it('units are emitted in deterministic breadth-first plan order from the entry', () => {
    const artifact = okArtifact();
    expect(artifact.plan.units.map((unit) => unit.unit)).toEqual([
      'fetch_issue', // entry (distance 0)
      'draft_summary', // distance 1
      'review_gate', // distance 2
      // distance 3 successors of review_gate, in canonical target order:
      'log_rejection',
      'notify_channel',
      'sync_backlog',
    ]);
  });

  it('the plan order is independent of authoring order (semantic determinism)', () => {
    const a = okArtifact().plan.units.map((unit) => unit.unit);
    const b = okArtifact(buildTriageDocumentAltOrder()).plan.units.map((unit) => unit.unit);
    expect(a).toEqual(b);
  });

  it('success edges are flattened to ordered onSuccess successors', () => {
    const draft = okArtifact().plan.units.find((unit) => unit.unit === 'draft_summary');
    expect(draft?.onSuccess).toEqual(['review_gate']);
    expect(draft?.onFailure).toBeNull();
    expect(draft?.onOutcomes).toEqual([]);
  });

  it('human outcome fan-out is flattened to ordered outcome successors', () => {
    const gate = okArtifact().plan.units.find((unit) => unit.unit === 'review_gate');
    expect(gate?.onOutcomes).toEqual([
      { outcome: 'approved', to: 'notify_channel' },
      { outcome: 'approved', to: 'sync_backlog' },
      { outcome: 'rejected', to: 'log_rejection' },
    ]);
  });

  it('failure policies are carried per unit (retry budget, failover, ignore)', () => {
    const artifact = okArtifact();
    expect(artifact.plan.units.find((unit) => unit.unit === 'draft_summary')?.failurePolicy).toEqual({
      strategy: 'retry_then_fail_workflow',
      maxAttempts: 2,
    });
    expect(artifact.plan.units.find((unit) => unit.unit === 'log_rejection')?.failurePolicy).toEqual({
      strategy: 'ignore_and_continue',
    });
    expect(artifact.plan.units.find((unit) => unit.unit === 'sync_backlog')?.failurePolicy).toEqual({
      strategy: 'retry_then_fail_workflow',
      maxAttempts: 3,
    });
  });

  it('completion evidence classes are carried per unit', () => {
    const artifact = okArtifact();
    expect(artifact.plan.units.find((unit) => unit.unit === 'fetch_issue')?.completionEvidence).toBe(
      'observation',
    );
    expect(artifact.plan.units.find((unit) => unit.unit === 'review_gate')?.completionEvidence).toBe(
      'human_confirmation',
    );
    expect(artifact.plan.units.find((unit) => unit.unit === 'draft_summary')?.completionEvidence).toBeUndefined();
  });

  it('input bindings and output ports are carried per unit, sorted by port name', () => {
    const notify = okArtifact().plan.units.find((unit) => unit.unit === 'notify_channel');
    expect(notify?.inputs.map((input) => input.name)).toEqual(['channel', 'credentials', 'text']);
    expect(notify?.outputs.map((output) => output.name)).toEqual(['messageId']);
    const text = notify?.inputs.find((input) => input.name === 'text');
    expect(text?.binding).toEqual({ kind: 'node_output', node: 'draft_summary', output: 'summary' });
  });

  it('a failover policy flattens to exactly one onFailure successor', () => {
    // fetch_issue with a failover policy + a failure edge to log_rejection
    const document = withEdge(
      withNode(AUTHORED, 'fetch_issue', { failurePolicy: { strategy: 'failover' } }),
      { from: 'fetch_issue', to: 'log_rejection', on: 'failure' },
    );
    const result = compileWorkflow(document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fetch = result.artifact.plan.units.find((unit) => unit.unit === 'fetch_issue');
      expect(fetch?.onFailure).toBe('log_rejection');
    }
  });
});

describe('V2-007 — cyclic control is IR-valid but compiler-v1-unrepresentable (rejected)', () => {
  // The interrupted dispatch's fixture probe (re-verified 2026-09-01) proved
  // the merged V2-003 validator ACCEPTS cyclic control graphs (there is no
  // acyclicity rule in the IR). This compiler (v1) compiles ACYCLIC
  // executable plans only: a cyclic source is an IR-valid-but-compiler-
  // unrepresentable document and MUST be rejected with a typed GRAPH_INVALID
  // diagnostic — never silently unrolled, truncated, or guessed forward.
  // Loop semantics require a governed later compiler version.
  const backEdge = { from: 'log_rejection', to: 'draft_summary', on: 'success' } as const;

  it('a cyclic control graph is IR-VALID (the compiler layer is load-bearing)', () => {
    expect(validateWorkflowIrDocument(withEdge(AUTHORED, backEdge)).ok).toBe(true);
  });

  it('a cyclic control graph is rejected with a GRAPH_INVALID diagnostic naming the cycle', () => {
    const result = compileWorkflow(withEdge(AUTHORED, backEdge));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const graph = result.diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID');
      expect(graph).toBeDefined();
      expect(graph?.message).toContain('draft_summary');
      expect(graph?.message).toContain('log_rejection');
      expect('artifact' in result).toBe(false);
    }
  });

  it('the cyclic rejection is deterministic (identical diagnostics, identical order)', () => {
    const cyclic = withEdge(AUTHORED, backEdge);
    const first = compileWorkflow(cyclic);
    const second = compileWorkflow(cyclic);
    expect(first).toEqual(second);
  });

  it('a different cycle (back edge into the approval gate) is equally rejected', () => {
    const cyclic = withEdge(AUTHORED, { from: 'sync_backlog', to: 'review_gate', on: 'success' });
    expect(validateWorkflowIrDocument(cyclic).ok).toBe(true);
    const result = compileWorkflow(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
    }
  });
});

describe('V2-007 — invoked capabilities are declared for matching (pre-execution coherence)', () => {
  it('a deterministic step whose invoked capability is NOT declared in its requirements is rejected', () => {
    // notify_channel invokes `messaging.send` but declares only
    // `messaging.observe` — execution must never invoke an undeclared
    // capability (constitution §5: no silent substitution/emulation).
    const document = buildUndeclaredInvokedCapabilityDocument();
    expect(validateWorkflowIrDocument(document).ok).toBe(true);
    const result = compileWorkflow(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const capability = result.diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED');
      expect(capability).toBeDefined();
      expect(capability?.path).toContain('notify_channel');
      expect(capability?.message).toContain('messaging.send');
    }
  });

  it('the declared-invoked-capability rejection is deterministic', () => {
    const document = buildUndeclaredInvokedCapabilityDocument();
    expect(compileWorkflow(document)).toEqual(compileWorkflow(document));
  });
});
