import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeWorkflowVersionSemanticDigest, serializeWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import { computeContentDigest } from '../../../src/workflow-repository/internal/identity.js';
import {
  EXECUTION_STATEMENT_OBJECT_TYPE,
  canonicalStatementJson,
  computeExecutionDigest,
} from '../../../src/execution-attestation/index.js';
import { buildTriageDocument } from '../workflow-ir/helpers.js';
import {
  buildTriageStatement,
  buildTriageStatementAltOrder,
} from './helpers.js';

/**
 * V2-014 — the domain-separated ExecutionDigest.
 *
 *   - deterministic + equality across implementations/construction orders;
 *   - set-normalized (declared sets cannot change the digest by reordering);
 *   - DOMAIN SEPARATION from the V2-003 WorkflowVersion semantic digest, the
 *     V2-002 content digest, and the undomained hash of the same bytes;
 *   - the domain label is load-bearing (invariant 1 + registry executionDomain).
 */

describe('V2-014 ExecutionDigest determinism', () => {
  it('is deterministic across repeated computations', () => {
    const statement = buildTriageStatement();
    const first = computeExecutionDigest(statement);
    const second = computeExecutionDigest(statement);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is equal across independent construction orders (cross-implementation equality)', () => {
    const a = computeExecutionDigest(buildTriageStatement());
    const b = computeExecutionDigest(buildTriageStatementAltOrder());
    expect(a.digest).toBe(b.digest);
    expect(canonicalStatementJson(buildTriageStatement())).toBe(canonicalStatementJson(buildTriageStatementAltOrder()));
  });

  it('normalizes set-declared arrays (reordering commitments cannot change the digest)', () => {
    const base = buildTriageStatement();
    const reordered = buildTriageStatement({
      inputCommitments: [...base.inputCommitments].reverse(),
      causalParents: [...base.causalParents].reverse(),
      evidenceReferences: [...base.evidenceReferences].reverse(),
    });
    expect(computeExecutionDigest(base).digest).toBe(computeExecutionDigest(reordered).digest);
  });

  it('changes when ANY semantic binding changes', () => {
    const base = computeExecutionDigest(buildTriageStatement()).digest;
    const changes: Parameters<typeof buildTriageStatement>[0][] = [
      { runId: 'wfr-triage-20260901-9999' },
      { attemptId: 2 },
      { stepId: 'log_rejection' },
      { workflowVersionId: 'wfv-support-ticket-triage-2' },
      { workflowVersionSemanticDigest: 'f'.repeat(64) },
      { nonce: 'other-nonce' },
      { outcome: 'failed' },
      { action: 'Post the rejected triage summary to the log' },
      { nodeId: 'node_0000000000000000' },
      { epoch: 8 },
    ];
    for (const change of changes) {
      expect(computeExecutionDigest(buildTriageStatement(change)).digest, `digest must change under ${JSON.stringify(change)}`).not.toBe(base);
    }
  });

  it('carries the registry execution domain and sha-256 algorithm', () => {
    const digest = computeExecutionDigest(buildTriageStatement());
    expect(digest.domain).toBe(EXECUTION_STATEMENT_OBJECT_TYPE);
    expect(digest.domain).toBe('workflowos/execution-statement/v1');
    expect(digest.algorithm).toBe('sha-256');
  });
});

describe('V2-014 ExecutionDigest domain separation (invariant 1)', () => {
  const triage = buildTriageDocument();
  const semantic = computeWorkflowVersionSemanticDigest(triage);

  it('is NOT the WorkflowVersion semantic digest of the bound workflow', () => {
    const statement = buildTriageStatement({ workflowVersionSemanticDigest: semantic.digest });
    const execution = computeExecutionDigest(statement);
    expect(execution.digest).not.toBe(semantic.digest);
    expect(execution.domain).not.toBe(semantic.domain);
    expect(semantic.domain).toBe('workflowos/workflow-ir/v1');
  });

  it('is NOT a V2-002-style content digest of the statement object', () => {
    const statement = buildTriageStatement();
    expect(computeExecutionDigest(statement).digest).not.toBe(computeContentDigest(statement));
  });

  it('is NOT the undomained sha-256 of the canonical statement bytes (the domain is load-bearing)', () => {
    const statement = buildTriageStatement();
    const undomained = createHash('sha256').update(canonicalStatementJson(statement), 'utf8').digest('hex');
    expect(computeExecutionDigest(statement).digest).not.toBe(undomained);
  });

  it('is not derived from the serialized WorkflowIR document bytes', () => {
    const statement = buildTriageStatement();
    const irBytes = createHash('sha256').update(serializeWorkflowIrDocument(triage), 'utf8').digest('hex');
    expect(computeExecutionDigest(statement).digest).not.toBe(irBytes);
  });

  it('binds the WorkflowVersion semantic digest as reference DATA (not by recomputation)', () => {
    // the statement commits to the semantic digest value; the two digests
    // remain distinct identities even when both describe the same workflow:
    const statement = buildTriageStatement({ workflowVersionSemanticDigest: semantic.digest });
    const execution = computeExecutionDigest(statement);
    expect(execution.digest).not.toBe(semantic.digest);
    // and a different version binding changes the execution digest:
    const otherVersion = buildTriageStatement({ workflowVersionSemanticDigest: 'a'.repeat(64) });
    expect(computeExecutionDigest(otherVersion).digest).not.toBe(execution.digest);
  });
});
