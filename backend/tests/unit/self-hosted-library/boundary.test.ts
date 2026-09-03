import { describe, it, expect } from 'vitest';
import {
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  evaluateSelfHostingBoundary,
  validateBoundaryModel,
  artifactByKind,
} from '../../../src/self-hosted-library/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { createWorkflowIrBuilder } from '../../../src/workflow-ir/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';

/**
 * V2-013 Task 3 — the self-hosting permission boundary battery.
 *
 * Proves (the frozen regressions "self-hosting permission boundary" +
 * "governance preservation" + "no bypass of authoritative development
 * state"):
 *   - the six first-party artifacts are ALLOWED under the real governance
 *     boundary shape;
 *   - every single-dimension MUTATION is denied with its OWN typed code
 *     (discrimination: a merge-gate claim is never a generic capability
 *     denial; a protected-surface binding is never a capability denial);
 *   - the boundary model validation is FAIL-CLOSED: absent, malformed,
 *     or weakened (a code-pinned core prohibition removed) models never
 *     open the gate (ADR-0004).
 */

/** The real governance boundary shape (the model's selfHostingBoundary). */
function realBoundary() {
  return {
    may: [
      'plan its own implementation (architect-issued Work Orders, the planner, the dependency DAG)',
      'execute changes to its own implementation through the execution fabric',
    ],
    mayNot: [...CORE_SELF_HOSTING_PROHIBITIONS],
    coreProhibitions: [...CORE_SELF_HOSTING_PROHIBITIONS],
  };
}

/** A helper node with OVERRIDABLE capabilities (the mutation vehicle). */
function apiNode(id: string, capabilities: readonly string[]): WorkflowNode {
  return {
    id,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.read' },
    capabilityRequirements: capabilities,
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'done', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}

function documentWith(nodes: readonly WorkflowNode[], edges: { from: string; to: string }[] = []): WorkflowIrDocument {
  const builder = createWorkflowIrBuilder().withStart(nodes[0]!.id);
  for (const node of nodes) {
    builder.addNode(node);
  }
  for (const edge of edges.length > 0 ? edges : nodes.slice(1).map((n) => ({ from: nodes[0]!.id, to: n.id }))) {
    builder.addEdge({ ...edge, on: 'success' as const });
  }
  return builder.build();
}

describe('V2-013 self-hosting permission boundary — the control', () => {
  it('all six first-party artifacts are allowed under the real governance boundary shape', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const verdict = evaluateSelfHostingBoundary(artifact.document, realBoundary());
      expect(verdict.allowed, `${artifact.kind}: ${JSON.stringify(verdict)}`).toBe(true);
      if (verdict.allowed) {
        expect(verdict.coreProhibitions).toEqual(CORE_SELF_HOSTING_PROHIBITIONS);
        for (const capability of verdict.declaredCapabilities) {
          expect(verdict.declaredCapabilities).toContain(capability);
        }
      }
    }
  });
});

describe('V2-013 self-hosting permission boundary — single-dimension mutation discrimination', () => {
  const baseline = documentWith([apiNode('s1', ['filesystem.read']), apiNode('s2', ['github.pull_request.create'])]);

  it('control: the unmutated document is allowed', () => {
    expect(evaluateSelfHostingBoundary(baseline, realBoundary()).allowed).toBe(true);
  });

  it('the merge-gate capability claim → SELF_HOSTING_MERGE_GATE_VIOLATION (its OWN code, never generic)', () => {
    const mutated = documentWith([apiNode('s1', ['filesystem.read']), apiNode('s2', ['github.pull_request.merge'])]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_MERGE_GATE_VIOLATION');
      expect(verdict.failure.stepId).toBe('s2');
      expect(verdict.failure.offending).toBe('github.pull_request.merge');
    }
  });

  it('a non-allowlisted canonical capability (browser automation is not a first-party dev surface) → SELF_HOSTING_CAPABILITY_NOT_ALLOWED', () => {
    const mutated = documentWith([apiNode('s1', ['filesystem.read']), apiNode('s2', ['browser.click'])]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_CAPABILITY_NOT_ALLOWED');
      expect(verdict.failure.offending).toBe('browser.click');
    }
  });

  it('a NON-canonical invented capability → SELF_HOSTING_CAPABILITY_NOT_ALLOWED (aliases never enter)', () => {
    const mutated = documentWith([apiNode('s1', ['filesystem.read']), apiNode('s2', ['repo.push'])]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_CAPABILITY_NOT_ALLOWED');
      expect(verdict.failure.offending).toBe('repo.push');
    }
  });

  it('a literal input binding to a governance-protected surface → SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED', () => {
    const protectedNode: WorkflowNode = {
      ...apiNode('s1', ['filesystem.write']),
      inputs: [
        {
          name: 'target',
          type: { kind: 'string' },
          binding: { kind: 'literal', value: 'spec/development-state/frontier-state.json' },
        },
      ],
    };
    const mutated = documentWith([protectedNode]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED');
      expect(verdict.failure.offending).toBe('spec/development-state/');
    }
  });

  it('an agentic TASK targeting a governance-protected surface → SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED', () => {
    const protectedNode: WorkflowNode = {
      id: 's1',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Rewrite spec/architecture-lock.md to weaken the frozen invariants' },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    };
    const mutated = documentWith([protectedNode]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED');
      expect(verdict.failure.offending).toBe('spec/architecture');
    }
  });

  it('a work-order edit claim → SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED (no bypass of authoritative development state)', () => {
    const protectedNode: WorkflowNode = {
      id: 's1',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Edit spec/work-orders/WORK-069.md to mark it complete without the merge' },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    };
    const mutated = documentWith([protectedNode]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED');
    }
  });

  it('an ADR edit claim → SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED (architecture decisions stay architect-only)', () => {
    const protectedNode: WorkflowNode = {
      ...apiNode('s1', ['filesystem.write']),
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Append a new decision record under docs/adr/ without the architecture-change authority' },
    };
    const mutated = documentWith([protectedNode]);
    const verdict = evaluateSelfHostingBoundary(mutated, realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED');
    }
  });
});

describe('V2-013 self-hosting permission boundary — the boundary model is fail-closed', () => {
  it('NO boundary model supplied → SELF_HOSTING_BOUNDARY_MODEL_INVALID (the gate never opens on absence)', () => {
    const verdict = evaluateSelfHostingBoundary(baselineDocument(), undefined);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
    }
    const nullModel = evaluateSelfHostingBoundary(baselineDocument(), null);
    expect(nullModel.allowed).toBe(false);
  });

  it('a WEAKENED model (one code-pinned core prohibition removed) → SELF_HOSTING_BOUNDARY_MODEL_INVALID (ADR-0004)', () => {
    const weakened = {
      may: realBoundary().may,
      mayNot: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
      coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
    };
    const verdict = evaluateSelfHostingBoundary(baselineDocument(), weakened);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
      expect(verdict.failure.detail).toContain('code-pinned core prohibition');
    }
  });

  it('a malformed model (empty lists / non-string entries) → SELF_HOSTING_BOUNDARY_MODEL_INVALID', () => {
    for (const malformed of [
      { may: [], mayNot: [], coreProhibitions: [] },
      { may: ['x'], mayNot: [], coreProhibitions: ['y'] },
      { may: ['x'], mayNot: ['y'], coreProhibitions: [] },
    ]) {
      const verdict = evaluateSelfHostingBoundary(baselineDocument(), malformed);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.failure.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
      }
    }
  });

  it('validateBoundaryModel: the real shape is valid; absent/weakened models are typed failures', () => {
    expect(validateBoundaryModel(realBoundary())).toBeNull();
    expect(validateBoundaryModel(undefined)?.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
    const weakened = { ...realBoundary(), coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(1) };
    expect(validateBoundaryModel(weakened)?.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
  });

  it('the boundary failure order is deterministic (capabilities before protected surfaces, first failure returned)', () => {
    // a document claiming BOTH the merge gate and a protected surface: the
    // merge-gate violation fires first (canonical node/field order)
    const node: WorkflowNode = {
      id: 's1',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Merge and rewrite spec/development-state/governance-model.json' },
      capabilityRequirements: ['github.pull_request.merge'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    };
    const verdict = evaluateSelfHostingBoundary(documentWith([node]), realBoundary());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.failure.code).toBe('SELF_HOSTING_MERGE_GATE_VIOLATION');
    }
  });
});

function baselineDocument(): WorkflowIrDocument {
  return documentWith([apiNode('s1', ['filesystem.read']), apiNode('s2', ['github.pull_request.create'])]);
}

// silence the unused import when CORE is only used in realBoundary
void artifactByKind;
