import { describe, it, expect } from 'vitest';
import {
  computeWorkflowVersionSemanticDigest,
  negotiateWorkflowVersionUpdate,
  parseWorkflowIrDocument,
  semanticallyEqual,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
  WORKFLOW_IR_REGISTRY_VOCABULARY,
} from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  clone,
  withCompatibility,
  withIr,
  SECRET_MATERIAL_CANARY,
} from '../../unit/workflow-ir/helpers.js';

/**
 * V2-003 (integration) — the feature-boundary dogfooding experiment, executed
 * through the real module surface (author → validate → serialize →
 * deserialize → re-validate → semantic equality + digest stability →
 * cross-client equivalence → version negotiation).
 *
 * The workflow under test is the real "triage an inbound GitHub issue"
 * workflow: observation step (deterministic API + observation completion
 * evidence), agentic drafting, human approval gate, secret-referenced
 * credentials, subworkflow dependency, placement constraints and failure
 * policy. "Execute/inspect" at this boundary means inspecting meaning through
 * the IR's own semantic/validator API — actual execution arrives with
 * V2-005+ (explicit observation, recorded in the evidence file, never hidden).
 */

describe('V2-003 dogfooding — round-trip of the real triage workflow', () => {
  const authored = buildTriageDocument();

  it('step 1 — the authored workflow is valid at authoring time', () => {
    expect(validateWorkflowIrDocument(authored).ok).toBe(true);
  });

  it('step 2 — serialization is canonical and material-free', () => {
    const bytes = serializeWorkflowIrDocument(authored);
    expect(bytes).not.toContain(SECRET_MATERIAL_CANARY);
    expect(bytes).toContain('team-notifications@secrets');
    expect(bytes).not.toMatch(/[\n\r\t]/);
    expect(bytes).not.toMatch(/[:,{}[\]]\s/);
  });

  it('step 3 — deserialization + re-validation preserves the document', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(validateWorkflowIrDocument(parsed.document).ok).toBe(true);
    }
  });

  it('step 4 — the round-tripped workflow is semantically identical to the authored one', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(semanticallyEqual(parsed.document, authored)).toBe(true);
    }
  });

  it('step 5 — the WorkflowVersion semantic digest is stable across the round trip', () => {
    const before = computeWorkflowVersionSemanticDigest(authored).digest;
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const after = computeWorkflowVersionSemanticDigest(parsed.document).digest;
      expect(after).toBe(before);
      expect(after).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('step 6 — a second independent authoring path yields identical canonical bytes', () => {
    const bytesA = serializeWorkflowIrDocument(authored);
    const bytesB = serializeWorkflowIrDocument(buildTriageDocumentAltOrder());
    expect(bytesA).toBe(bytesB);
  });

  it('step 7 — inspecting meaning through the semantic API: the approval gate is a human pause point', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const gate = parsed.document.ir.nodes.find((node) => node.id === 'review_gate');
      expect(gate?.executionClass).toBe('human');
      const gateEdges = parsed.document.ir.edges.filter((edge) => edge.from === 'review_gate');
      // pause-safe: every declared outcome has an explicit continuation
      const outcomes = new Set(
        gateEdges.map((edge) => (typeof edge.on === 'string' ? edge.on : edge.on.outcome)),
      );
      expect(outcomes.has('approved')).toBe(true);
      expect(outcomes.has('rejected')).toBe(true);
    }
  });

  it('step 8 — inspecting meaning through the semantic API: capability requirements are canonical', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(authored));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const capabilities = new Set(
        parsed.document.ir.nodes.flatMap((node) => node.capabilityRequirements),
      );
      const canonical = new Set(WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities);
      for (const capability of capabilities) {
        expect(canonical.has(capability)).toBe(true);
      }
      expect(capabilities.has('github.repository.read')).toBe(true);
      expect(capabilities.has('messaging.send')).toBe(true);
      expect(capabilities.has('workflow.execute')).toBe(true);
    }
  });

  it('step 9 — an honest compatible v2 (adds an optional input) negotiates to upgrade', () => {
    const candidate = withCompatibility(
      withIr(buildTriageDocument(), {
        inputs: [
          { name: 'issueUrl', type: { kind: 'string' } },
          { name: 'channel', type: { kind: 'string' }, optional: true },
          { name: 'priority', type: { kind: 'string' }, optional: true },
        ],
      }),
      { compatibilityLevel: 'compatible', inputSurfaceChange: 'additive', outputSurfaceChange: 'none' },
    );
    expect(validateWorkflowIrDocument(candidate).ok).toBe(true);
    const decision = negotiateWorkflowVersionUpdate({
      installed: {
        inputs: authored.ir.inputs,
        outputs: authored.ir.outputs,
        compatibility: authored.compatibility,
      },
      candidate: {
        inputs: candidate.ir.inputs,
        outputs: candidate.ir.outputs,
        compatibility: candidate.compatibility,
      },
    });
    expect(decision.decision).toBe('upgrade');
    // and the two versions are DIFFERENT semantic versions (different digests)
    expect(computeWorkflowVersionSemanticDigest(candidate).digest).not.toBe(
      computeWorkflowVersionSemanticDigest(authored).digest,
    );
  });

  it('step 10 — a dishonest v2 (declares equivalent but adds a REQUIRED input) is rejected', () => {
    const dishonest = withCompatibility(
      withIr(buildTriageDocument(), {
        inputs: [
          { name: 'issueUrl', type: { kind: 'string' } },
          { name: 'channel', type: { kind: 'string' }, optional: true },
          { name: 'requiredNewInput', type: { kind: 'string' } },
        ],
      }),
      { compatibilityLevel: 'equivalent', inputSurfaceChange: 'none', outputSurfaceChange: 'none' },
    );
    const decision = negotiateWorkflowVersionUpdate({
      installed: {
        inputs: authored.ir.inputs,
        outputs: authored.ir.outputs,
        compatibility: authored.compatibility,
      },
      candidate: {
        inputs: dishonest.ir.inputs,
        outputs: dishonest.ir.outputs,
        compatibility: dishonest.compatibility,
      },
    });
    expect(decision.decision).toBe('reject');
  });

  it('the digest is stable across a pure re-validation loop (no drift from repeated inspection)', () => {
    let current = clone(authored);
    let digest = computeWorkflowVersionSemanticDigest(current).digest;
    for (let i = 0; i < 5; i += 1) {
      const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(current));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        current = parsed.document;
        const nextDigest = computeWorkflowVersionSemanticDigest(current).digest;
        expect(nextDigest).toBe(digest);
        digest = nextDigest;
      }
    }
  });
});
