import { describe, it, expect } from 'vitest';
import { validateExecutionStatement } from '../../../src/execution-attestation/index.js';
import { buildTriageStatement } from './helpers.js';

/**
 * V2-014 — ExecutionStatement schema validation (execution-attestation.md
 * §ExecutionStatement): exact key sets (no smuggling surface), canonical
 * registry vocabularies, commitment shapes, fixed-format bounded timestamps,
 * freshness material, and the outcome vocabulary.
 */

describe('V2-014 ExecutionStatement validation', () => {
  it('accepts the canonical fixture statement', () => {
    const result = validateExecutionStatement(buildTriageStatement());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('accepts the same statement with every key in a different order', () => {
    const result = validateExecutionStatement(buildTriageStatement());
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown extra key (no smuggling surface for secrets)', () => {
    const statement = buildTriageStatement();
    const smuggled = { ...statement, credentials: 'ghp_live_DEADBEEF' } as never;
    const result = validateExecutionStatement(smuggled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code.includes('UNKNOWN'))).toBe(true);
    }
  });

  it('rejects a wrong statement object type (cross-object substitution)', () => {
    const result = validateExecutionStatement(buildTriageStatement({ objectType: 'workflowos/execution-attestation/v1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a WorkflowIR document presented as a statement (cross-protocol substitution)', () => {
    const irDocument = { objectType: 'workflowos/workflow-ir/v1', irSchemaVersion: 1, ir: {} };
    const result = validateExecutionStatement(irDocument as never);
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported statement schema version', () => {
    const result = validateExecutionStatement(buildTriageStatement({ statementSchemaVersion: 99 }));
    expect(result.ok).toBe(false);
  });

  it('rejects missing required binding fields individually', () => {
    for (const field of ['workflowId', 'workflowVersionId', 'workflowVersionSemanticDigest', 'deploymentId', 'runId', 'attemptId', 'nodeId', 'executionClass', 'action', 'nonce', 'epoch', 'outcome', 'executedAt']) {
      const statement = buildTriageStatement();
      const partial = { ...statement } as Record<string, unknown>;
      delete partial[field];
      const result = validateExecutionStatement(partial as never);
      expect(result.ok, `missing ${field} must be rejected`).toBe(false);
    }
  });

  it('rejects empty/whitespace identifiers', () => {
    for (const field of ['workflowId', 'workflowVersionId', 'deploymentId', 'runId', 'nodeId', 'action', 'nonce']) {
      const result = validateExecutionStatement(buildTriageStatement({ [field]: '   ' } as never));
      expect(result.ok, `blank ${field} must be rejected`).toBe(false);
    }
  });

  it('requires attemptId to be an integer >= 1', () => {
    expect(validateExecutionStatement(buildTriageStatement({ attemptId: 0 })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ attemptId: -1 })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ attemptId: 1.5 })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ attemptId: '1' as never })).ok).toBe(false);
  });

  it('requires a non-canonical execution class to be rejected (registry vocabulary)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ executionClass: 'api_call' as never })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ executionClass: 'DETERMINISTIC_API' as never })).ok).toBe(false);
  });

  it('requires the invoked capability to be a canonical registry capability name (aliases rejected)', () => {
    // non-canonical alias of messaging.send:
    expect(validateExecutionStatement(buildTriageStatement({ capability: 'messages.send' })).ok).toBe(false);
    // SDK-shaped name (not a protocol identifier):
    expect(validateExecutionStatement(buildTriageStatement({ capability: 'slack.postMessage' })).ok).toBe(false);
    // canonical:
    expect(validateExecutionStatement(buildTriageStatement({ capability: 'messaging.send' })).ok).toBe(true);
  });

  it('requires commitments to be lowercase sha-256 hex (raw values cannot be committed)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ inputCommitments: ['not-a-digest'] })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ inputCommitments: ['9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08'.toLowerCase()] })).ok).toBe(true);
    expect(validateExecutionStatement(buildTriageStatement({ causalParents: ['short'] })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ workflowVersionSemanticDigest: 'zz' })).ok).toBe(false);
  });

  it('requires fixed-format UTC timestamps (YYYY-MM-DDTHH:MM:SS.sssZ)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ executedAt: '2026-09-01T12:00:00Z' })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ executedAt: '2026-09-01 12:00:00.000Z' })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ executedAt: 'not-a-time' })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ validUntil: '2026-13-01T12:00:00.000Z' })).ok).toBe(false);
  });

  it('requires validUntil to be strictly after executedAt (bounded interval)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ validUntil: '2026-09-01T11:59:59.000Z' })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ validUntil: '2026-09-01T12:00:00.000Z' })).ok).toBe(false);
  });

  it('requires the outcome vocabulary (succeeded | failed)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ outcome: 'completed' as never })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ outcome: 'SUCCEEDED' as never })).ok).toBe(false);
  });

  it('requires epoch to be a non-negative integer and the nonce non-empty', () => {
    expect(validateExecutionStatement(buildTriageStatement({ epoch: -1 })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ epoch: 2.5 })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ nonce: '' })).ok).toBe(false);
  });

  it('rejects malformed evidence references (control characters, emptiness)', () => {
    expect(validateExecutionStatement(buildTriageStatement({ evidenceReferences: [''] })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ evidenceReferences: ['has\nnewline'] })).ok).toBe(false);
  });

  it('treats the optional fields as optional and validates them when present', () => {
    expect(validateExecutionStatement(buildTriageStatement({ stepId: undefined, workloadIdentity: undefined, capability: undefined, authorizationContextDigest: undefined, placementPolicyDigest: undefined, validUntil: undefined })).ok).toBe(true);
    expect(validateExecutionStatement(buildTriageStatement({ stepId: '' })).ok).toBe(false);
    expect(validateExecutionStatement(buildTriageStatement({ workloadIdentity: '' })).ok).toBe(false);
  });
});
