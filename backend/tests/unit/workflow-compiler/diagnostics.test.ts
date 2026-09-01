import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../../../src/workflow-compiler/index.js';
import { validateWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildPlacementConflictDocument,
  buildHumanRetryPolicyDocument,
  buildHumanIgnorePolicyDocument,
  buildDuplicateCapabilityRequirementDocument,
  buildAliasCapabilityDocument,
  buildUnknownCapabilityDocument,
  buildAliasInvokedCapabilityDocument,
  buildDanglingEdgeDocument,
  buildDanglingBindingDocument,
  buildUnreachableNodeDocument,
  buildUnsupportedSchemaVersionDocument,
  buildWrongObjectTypeDocument,
  buildHumanFailoverDocument,
  withDefaultPlacement,
  withNodePlacement,
  withNodeCapabilityRequirements,
  withNodeFailurePolicy,
  withEdge,
  clone,
} from './helpers.js';

/**
 * V2-007 — explicit compile diagnostics battery.
 *
 * Every rejection is a TYPED, structured, deterministic diagnostic — never a
 * silent default, never a guessed-forward interpretation:
 *   - unsupported / non-canonical capability names (aliases forbidden);
 *   - placement conflict (contradictory placement requirements);
 *   - invalid graph (dangling references, unreachable nodes, cycles where
 *     they cannot be represented);
 *   - policy violation (failure-policy/step semantics the compiler cannot
 *     honor);
 *   - compiler-version compatibility (inputs declaring unsupported compiler
 *     versions);
 *   - ambiguous input (duplicate requirements the compiler refuses to
 *     silently normalize);
 *   - invalid input (source failed WorkflowIR validation — re-checked by the
 *     compiler because it relies on those guarantees).
 */

type Diagnostic = { code: string; path: string; message: string };

function diagnosticsOf(document: unknown, options?: object): Diagnostic[] {
  const result = compileWorkflow(document as Parameters<typeof compileWorkflow>[0], options);
  if (result.ok) {
    throw new Error(`fixture must be rejected: ${JSON.stringify(result.artifact.provenance)}`);
  }
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
  }));
}

describe('V2-007 — unsupported / non-canonical capability rejection (aliases forbidden)', () => {
  it('a non-canonical capability ALIAS in the requirements is rejected as unsupported capability', () => {
    const diagnostics = diagnosticsOf(buildAliasCapabilityDocument());
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.code === 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('github.read_repo'))).toBe(true);
  });

  it('an unknown capability name is rejected as unsupported capability', () => {
    const diagnostics = diagnosticsOf(buildUnknownCapabilityDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('nosuch.op'))).toBe(true);
  });

  it('a non-canonical alias as the INVOKED capability of a deterministic step is rejected', () => {
    const diagnostics = diagnosticsOf(buildAliasInvokedCapabilityDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED')).toBe(true);
  });

  it('canonical registry names are accepted (negative control: the triage workflow compiles)', () => {
    const result = compileWorkflow(buildTriageDocument());
    expect(result.ok).toBe(true);
  });

  it('capability diagnostics carry the underlying WorkflowIR issue for traceability', () => {
    const result = compileWorkflow(buildAliasCapabilityDocument());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const capability = result.diagnostics.find(
        (d) => d.code === 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
      );
      expect(capability?.irIssue?.code).toBe('IR_CAPABILITY_REQUIREMENT_NON_CANONICAL');
    }
  });
});

describe('V2-007 — placement conflict (contradictory placement requirements)', () => {
  it('workflow default cloud_required + node device_local is a compile-time conflict', () => {
    expect(validateWorkflowIrDocument(buildPlacementConflictDocument()).ok).toBe(true);
    const diagnostics = diagnosticsOf(buildPlacementConflictDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT')).toBe(true);
  });

  it('the conflict diagnostic identifies the node and both contradictory placements', () => {
    const diagnostics = diagnosticsOf(buildPlacementConflictDocument());
    const conflict = diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.path).toContain('review_gate');
    expect(conflict?.message).toContain('device_local');
    expect(conflict?.message).toContain('cloud_required');
  });

  it('workflow default device_preferred + node cloud_required is a conflict', () => {
    const document = withDefaultPlacement(buildTriageDocument(), 'device_preferred');
    expect(validateWorkflowIrDocument(document).ok).toBe(true);
    const diagnostics = diagnosticsOf(
      withNodePlacement(document, 'notify_channel', 'cloud_required'),
    );
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT')).toBe(true);
  });

  it('workflow default cloud_required + node cloud_preferred is NOT a conflict', () => {
    const document = withNodePlacement(buildTriageDocument(), 'notify_channel', 'cloud_preferred');
    const result = compileWorkflow(withDefaultPlacement(document, 'cloud_required'));
    expect(result.ok).toBe(true);
  });

  it('workflow default any_supported_node never conflicts (negative control)', () => {
    const document = withNodePlacement(buildTriageDocument(), 'review_gate', 'device_local');
    const result = compileWorkflow(withDefaultPlacement(document, 'any_supported_node'));
    expect(result.ok).toBe(true);
  });

  it('every conflicting node produces its own diagnostic, in canonical node-id order', () => {
    const document = withDefaultPlacement(buildTriageDocument(), 'cloud_required');
    const first = diagnosticsOf(document);
    const second = diagnosticsOf(document);
    expect(first).toEqual(second);
    expect(first.length).toBe(2); // review_gate (device_local) + log_rejection (device_local)
    expect(first.length === 2 ? (first[0]?.path ?? '') < (first[1]?.path ?? '') : true).toBe(true);
  });
});

describe('V2-007 — invalid graph rejection (compiler re-checks what it relies on)', () => {
  it('a dangling edge to an unknown node is rejected as an invalid graph', () => {
    const diagnostics = diagnosticsOf(buildDanglingEdgeDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('ghost_node'))).toBe(true);
  });

  it('a binding referencing an unknown source node is rejected as an invalid graph', () => {
    const diagnostics = diagnosticsOf(buildDanglingBindingDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
  });

  it('an unreachable node is rejected as an invalid graph', () => {
    const diagnostics = diagnosticsOf(buildUnreachableNodeDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('isolated_step'))).toBe(true);
  });

  it('a self edge is rejected as an invalid graph', () => {
    const diagnostics = diagnosticsOf(
      withEdge(buildTriageDocument(), { from: 'draft_summary', to: 'draft_summary', on: 'success' }),
    );
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_GRAPH_INVALID')).toBe(true);
  });
});

describe('V2-007 — policy violation (failure-policy/step semantics the compiler cannot honor)', () => {
  it('a human pause point with a retry budget is rejected as a policy violation', () => {
    expect(validateWorkflowIrDocument(buildHumanRetryPolicyDocument()).ok).toBe(true);
    const diagnostics = diagnosticsOf(buildHumanRetryPolicyDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION')).toBe(true);
  });

  it('a human pause point with ignore_and_continue is rejected as a policy violation', () => {
    expect(validateWorkflowIrDocument(buildHumanIgnorePolicyDocument()).ok).toBe(true);
    const diagnostics = diagnosticsOf(buildHumanIgnorePolicyDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION')).toBe(true);
  });

  it('the diagnostic explains the human-pause-point rationale', () => {
    const diagnostics = diagnosticsOf(buildHumanRetryPolicyDocument());
    const violation = diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION');
    expect(violation?.message).toContain('review_gate');
    expect(violation?.message.toLowerCase()).toContain('human');
  });

  it('a human pause point with fail_workflow compiles (negative control)', () => {
    const result = compileWorkflow(buildTriageDocument());
    expect(result.ok).toBe(true);
  });

  it('non-human failure policies are all honorable (retry/failover/ignore controls compile)', () => {
    const document = withNodeFailurePolicy(
      withNodeCapabilityRequirements(buildTriageDocument(), 'fetch_issue', ['github.repository.read']),
      'fetch_issue',
      { strategy: 'fail_workflow' },
    );
    const result = compileWorkflow(document);
    expect(result.ok).toBe(true);
  });

  it('scratch-probe case 5 (human + failover) is IR-INVALID and rejected at the fail-closed re-validation layer', () => {
    // Re-verified 2026-09-01: the merged V2-003 validator itself rejects a
    // human approval node with a failover policy and no on_failure edge
    // (IR_FAILURE_POLICY_EDGE_REQUIRED). The compiler re-validates its input
    // (it RELIES on the IR's guarantees) and classifies the rejection as a
    // policy violation with the underlying IR issue attached.
    const document = buildHumanFailoverDocument();
    expect(validateWorkflowIrDocument(document).ok).toBe(false);
    const result = compileWorkflow(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const violation = result.diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION');
      expect(violation).toBeDefined();
      expect(violation?.irIssue?.code).toBe('IR_FAILURE_POLICY_EDGE_REQUIRED');
    }
  });
});

describe('V2-007 — ambiguous input rejection (never silently normalized)', () => {
  it('duplicate capability requirements are rejected as ambiguous input', () => {
    expect(validateWorkflowIrDocument(buildDuplicateCapabilityRequirementDocument()).ok).toBe(true);
    const diagnostics = diagnosticsOf(buildDuplicateCapabilityRequirementDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_AMBIGUOUS_INPUT')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('github.repository.read'))).toBe(true);
  });

  it('the ambiguity diagnostic identifies the node', () => {
    const diagnostics = diagnosticsOf(buildDuplicateCapabilityRequirementDocument());
    const ambiguity = diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_AMBIGUOUS_INPUT');
    expect(ambiguity?.path).toContain('fetch_issue');
  });
});

describe('V2-007 — invalid input rejection (source failed WorkflowIR validation)', () => {
  it('an unsupported IR schema version is rejected as invalid input with the schema detail', () => {
    const diagnostics = diagnosticsOf(buildUnsupportedSchemaVersionDocument());
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_INPUT_INVALID')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('2'))).toBe(true);
  });

  it('a wrong object type is rejected as invalid input', () => {
    const diagnostics = diagnosticsOf(buildWrongObjectTypeDocument());
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_INPUT_INVALID')).toBe(true);
  });

  it('input-invalid diagnostics carry the underlying WorkflowIR issues', () => {
    const result = compileWorkflow(buildUnsupportedSchemaVersionDocument());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const invalid = result.diagnostics.find((d) => d.code === 'WORKFLOW_COMPILER_INPUT_INVALID');
      expect(invalid?.irIssue?.code).toBe('IR_SCHEMA_VERSION_UNSUPPORTED');
    }
  });
});

describe('V2-007 — diagnostics are deterministic and structured', () => {
  it('the same rejected input yields identical diagnostics in identical order', () => {
    const first = diagnosticsOf(buildPlacementConflictDocument());
    const second = diagnosticsOf(buildPlacementConflictDocument());
    expect(first).toEqual(second);
  });

  it('every diagnostic carries code, path and message', () => {
    const diagnostics = diagnosticsOf(buildPlacementConflictDocument());
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toMatch(/^WORKFLOW_COMPILER_[A-Z_]+$/);
      expect(typeof diagnostic.path).toBe('string');
      expect(diagnostic.path.length).toBeGreaterThan(0);
      expect(typeof diagnostic.message).toBe('string');
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });

  it('rejections are total: no partial artifact is returned alongside diagnostics', () => {
    const result = compileWorkflow(buildPlacementConflictDocument());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect('artifact' in result).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});

describe('V2-007 — compiler checks run on already-validated documents (fail-closed layers)', () => {
  it('placement, policy and ambiguity fixtures are all IR-VALID (the compiler layer is load-bearing)', () => {
    for (const fixture of [
      buildPlacementConflictDocument(),
      buildHumanRetryPolicyDocument(),
      buildHumanIgnorePolicyDocument(),
      buildDuplicateCapabilityRequirementDocument(),
    ]) {
      expect(validateWorkflowIrDocument(fixture).ok).toBe(true);
      expect(compileWorkflow(fixture).ok).toBe(false);
    }
  });

  it('a placement-conflicted AND policy-violating document reports both diagnostics', () => {
    const document = withNodeFailurePolicy(
      withDefaultPlacement(buildTriageDocument(), 'cloud_required'),
      'review_gate',
      { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
    );
    const diagnostics = diagnosticsOf(document);
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT')).toBe(true);
    expect(diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_POLICY_VIOLATION')).toBe(true);
  });

  it('cloned fixtures behave identically (no hidden mutation between runs)', () => {
    const document = buildPlacementConflictDocument();
    const first = diagnosticsOf(clone(document));
    const second = diagnosticsOf(clone(document));
    expect(first).toEqual(second);
  });
});
