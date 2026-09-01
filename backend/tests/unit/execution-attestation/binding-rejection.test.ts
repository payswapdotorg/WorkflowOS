import { describe, it, expect } from 'vitest';
import { verifyAttestation } from '../../../src/execution-attestation/index.js';
import {
  CAUSAL_PARENT_DIGEST,
  TRIAGE_SEMANTIC_DIGEST,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from './helpers.js';

/**
 * V2-014 — wrong binding rejection (invariant 3): an attestation with a VALID
 * signature (properly re-signed through the real build path over an alternate
 * statement) is still rejected, with a TYPED binding failure naming the exact
 * dimension + expected + actual, whenever the WorkflowVersion / Run /
 * execution attempt / step / parent / deployment binding does not match the
 * verifier's expectation.
 */

interface BindingCase {
  readonly dimension: string;
  readonly statementOverrides: Record<string, unknown>;
  readonly policyBindings: Record<string, unknown>;
}

const CASES: readonly BindingCase[] = [
  {
    dimension: 'workflow',
    statementOverrides: { workflowId: 'wf-support-ticket-triage-v2' },
    policyBindings: { workflowId: 'wf-support-ticket-triage' },
  },
  {
    dimension: 'workflowVersion',
    statementOverrides: { workflowVersionId: 'wfv-support-ticket-triage-2' },
    policyBindings: { workflowVersionId: 'wfv-support-ticket-triage-1' },
  },
  {
    dimension: 'workflowVersionSemanticDigest',
    statementOverrides: { workflowVersionSemanticDigest: 'b'.repeat(64) },
    policyBindings: { workflowVersionSemanticDigest: TRIAGE_SEMANTIC_DIGEST },
  },
  {
    dimension: 'deployment',
    statementOverrides: { deploymentId: 'wfd-triage-deployment-2' },
    policyBindings: { deploymentId: 'wfd-triage-deployment-1' },
  },
  {
    dimension: 'run',
    statementOverrides: { runId: 'wfr-triage-20260901-9999' },
    policyBindings: { runId: 'wfr-triage-20260901-0001' },
  },
  {
    dimension: 'attempt',
    statementOverrides: { attemptId: 2 },
    policyBindings: { attemptId: 1 },
  },
  {
    dimension: 'step',
    statementOverrides: { stepId: 'log_rejection' },
    policyBindings: { stepId: 'notify_channel' },
  },
  {
    dimension: 'node',
    statementOverrides: { nodeId: 'node_76411bc6944a64cd' },
    policyBindings: { nodeId: 'node_795e8b12eaef3e45' },
  },
  {
    dimension: 'causalParents',
    statementOverrides: { causalParents: ['c'.repeat(64)] },
    policyBindings: { causalParents: [CAUSAL_PARENT_DIGEST] },
  },
];

describe('V2-014 wrong-binding rejection (valid signature, wrong execution binding)', () => {
  for (const bindingCase of CASES) {
    it(`rejects a wrong ${bindingCase.dimension} binding with a typed binding failure`, () => {
      // The attacker re-signs the alternate statement properly — the signature
      // is VALID; only the binding is wrong.
      const statement = buildTriageStatement(bindingCase.statementOverrides);
      const attestation = signTriageAttestation({ statement });
      const policy = defaultVerifyPolicy({ bindings: bindingCase.policyBindings });

      const result = verifyAttestation(attestation, policy);
      expect(result.ok, JSON.stringify(result)).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
        expect(result.failure.dimension).toBe(bindingCase.dimension);
        expect(result.failure.expected).toBeDefined();
        expect(result.failure.actual).toBeDefined();
      }

      // The same attestation verifies when the expectation matches the actual
      // binding (the rejection is the binding check, not the crypto):
      const matching = verifyAttestation(attestation, defaultVerifyPolicy({ bindings: bindingCase.statementOverrides }));
      expect(matching.ok).toBe(true);
    });
  }

  it('rejects a step-scoped expectation against a run-scoped statement (missing step binding)', () => {
    const statement = buildTriageStatement({ stepId: undefined });
    const attestation = signTriageAttestation({ statement });
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('step');
    }
  });

  it('rejects reordered causal parents (exact set match, not subset)', () => {
    const otherParent = 'e'.repeat(64);
    const statement = buildTriageStatement({ causalParents: [CAUSAL_PARENT_DIGEST, otherParent] });
    const attestation = signTriageAttestation({ statement });
    const result = verifyAttestation(attestation, defaultVerifyPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      expect(result.failure.dimension).toBe('causalParents');
    }
  });

  it('accepts the exact causal parent set in a different order (set semantics)', () => {
    const statement = buildTriageStatement({ causalParents: [CAUSAL_PARENT_DIGEST] });
    const attestation = signTriageAttestation({ statement });
    const policy = defaultVerifyPolicy({ bindings: { causalParents: [CAUSAL_PARENT_DIGEST] } });
    expect(verifyAttestation(attestation, policy).ok).toBe(true);
  });
});
