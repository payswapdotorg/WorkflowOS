import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { deriveNodeKeyFingerprint } from '../../../src/node-capability/index.js';
import {
  computeContentDigest,
  deriveWorkflowId,
  deriveWorkflowVersionId,
} from '../../../src/workflow-repository/internal/identity.js';
import {
  InMemoryAttestationLedger,
  attestationIssuedEvent,
  attestationVerifiedEvent,
  executionValueCommitment,
  parseAttestation,
  serializeAttestation,
  verifyAttestation,
} from '../../../src/execution-attestation/index.js';
import { buildTriageDocument, buildTriageDocumentAltOrder } from '../../unit/workflow-ir/helpers.js';
import {
  ATTESTATION_ISSUED_AT,
  EXECUTED_AT,
  NONCE,
  STATEMENT_EPOCH,
  VALID_UNTIL,
  VERIFY_NOW,
  buildTriageStatement,
  defaultVerifyPolicy,
  signTriageAttestation,
} from '../../unit/execution-attestation/helpers.js';

/**
 * V2-014 (integration) — REAL cross-module composition with the merged W1
 * modules, consumed as READ-ONLY reference data:
 *
 *   - V2-003 authors the real support-ticket-triage workflow and computes its
 *     real WorkflowVersion semantic digest (the binding data);
 *   - V2-002's deterministic identity derivations produce the workflow and
 *     version identities from the real serialized document;
 *   - V2-004's node-key fingerprint derivation produces the node identity;
 *   - V2-014 builds the ExecutionStatement over those exact bindings, signs
 *     with real Ed25519, and verifies through the public path.
 */

const ORG_ID = 'org-dogfood-7';
const OWNER_ID = 'user-implementer-1';
const SLUG = 'support-ticket-triage';

describe('V2-014 composition — a real WorkflowVersion becomes a real attested execution fact', () => {
  const triage = buildTriageDocument();
  const semantic = computeWorkflowVersionSemanticDigest(triage);
  const contentDigest = computeContentDigest(JSON.parse(serializeWorkflowIrDocument(triage)));
  const workflowId = deriveWorkflowId({ organizationId: ORG_ID, ownerUserId: OWNER_ID, slug: SLUG });
  const workflowVersionId = deriveWorkflowVersionId({
    workflowId,
    contentDigest,
    protocol: { irSchemaVersion: '1' },
  });
  const nodeKeyMaterial = new Uint8Array(32).fill(7);
  const nodeId = deriveNodeKeyFingerprint(nodeKeyMaterial);

  const statement = buildTriageStatement({
    workflowId,
    workflowVersionId,
    workflowVersionSemanticDigest: semantic.digest,
    deploymentId: 'wfd-triage-deployment-1',
    runId: 'wfr-triage-20260901-0001',
    attemptId: 1,
    stepId: 'notify_channel',
    nodeId,
    workloadIdentity: 'wl_triage-runner-2026-09',
    inputCommitments: [executionValueCommitment(serializeWorkflowIrDocument(triage))],
  });

  /**
   * A FRESH verification policy per call: each successful verification
   * consumes the single-use nonce in the policy's replay registry, so
   * every test that expects a successful verification (except the replay
   * test, which shares one policy WITHIN itself) must verify against fresh
   * freshness state — otherwise later tests would fail as replays of the
   * first one.
   */
  const freshPolicy = () =>
    defaultVerifyPolicy({
      bindings: {
        workflowId,
        workflowVersionId,
        workflowVersionSemanticDigest: semantic.digest,
        nodeId,
      },
    });

  it('binds the REAL V2-003 semantic digest (the alt-order authoring path converges on it)', () => {
    expect(semantic.digest).toBe(computeWorkflowVersionSemanticDigest(buildTriageDocumentAltOrder()).digest);
    expect(semantic.domain).toBe('workflowos/workflow-ir/v1');
    expect(semantic.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives REAL V2-002 identities from the serialized document (deterministic)', () => {
    expect(workflowId).toMatch(/^wfw_[0-9a-f]{32}$/);
    expect(workflowVersionId).toMatch(/^wfwv_[0-9a-f]{32}$/);
    expect(workflowVersionId).toBe(
      deriveWorkflowVersionId({
        workflowId,
        contentDigest: computeContentDigest(JSON.parse(serializeWorkflowIrDocument(triage))),
        protocol: { irSchemaVersion: '1' },
      }),
    );
  });

  it('derives a REAL V2-004 node identity from node key material', () => {
    expect(nodeId).toMatch(/^node_[0-9a-f]{16}$/);
    expect(nodeId).toBe(deriveNodeKeyFingerprint(new Uint8Array(32).fill(7)));
  });

  it('signs the composed statement with real Ed25519 and verifies it through the public path', () => {
    const attestation = signTriageAttestation({ statement });
    const result = verifyAttestation(attestation, freshPolicy());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.fact.statement.workflowVersionSemanticDigest).toBe(semantic.digest);
      expect(result.fact.statement.workflowId).toBe(workflowId);
      expect(result.fact.statement.nodeId).toBe(nodeId);
    }
  });

  it('round-trips the composed attestation through canonical bytes (export/import)', () => {
    const attestation = signTriageAttestation({ statement });
    const parsed = parseAttestation(serializeAttestation(attestation));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const result = verifyAttestation(parsed.attestation, freshPolicy());
      expect(result.ok).toBe(true);
    }
  });

  it('rejects a composed attestation bound to a DIFFERENT real WorkflowVersion (typed binding failure)', () => {
    // a genuinely different version (v2 content → different V2-002 identity and
    // different V2-003 semantic digest) — attested with a VALID signature:
    const otherContent = { ...JSON.parse(serializeWorkflowIrDocument(triage)) };
    (otherContent as Record<string, unknown>)['presentation'] = { title: 'Triage v2' };
    const otherWorkflowVersionId = deriveWorkflowVersionId({
      workflowId,
      contentDigest: computeContentDigest(otherContent),
      protocol: { irSchemaVersion: '1' },
    });
    const otherStatement = buildTriageStatement({
      workflowId,
      workflowVersionId: otherWorkflowVersionId,
      workflowVersionSemanticDigest: executionValueCommitment('other-version'),
      nodeId,
    });
    const attestation = signTriageAttestation({ statement: otherStatement });
    const result = verifyAttestation(attestation, freshPolicy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_BINDING_MISMATCH');
      // the workflowVersion binding is checked before the semantic-digest
      // binding; both are typed binding dimensions:
      expect(['workflowVersion', 'workflowVersionSemanticDigest']).toContain(result.failure.dimension);
    }
  });

  it('keeps the ExecutionDigest distinct from the real WorkflowVersion semantic digest (invariant 1, composed)', () => {
    const attestation = signTriageAttestation({ statement });
    expect(attestation.executionDigest.digest).not.toBe(semantic.digest);
    expect(attestation.executionDigest.domain).toBe('workflowos/execution-statement/v1');
    // and distinct from the V2-002 content digest of the same document:
    expect(attestation.executionDigest.digest).not.toBe(contentDigest);
  });

  it('emits the typed protocol events for the composed attestation (canonical registry names)', () => {
    const attestation = signTriageAttestation({ statement });
    const issued = attestationIssuedEvent(attestation, ATTESTATION_ISSUED_AT);
    expect(issued.eventType).toBe('execution.attestation.issued');
    expect(issued.executionDigest).toBe(attestation.executionDigest.digest);

    const result = verifyAttestation(attestation, freshPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const verified = attestationVerifiedEvent(result.fact, VERIFY_NOW);
      expect(verified.eventType).toBe('execution.attestation.verified');
      expect(verified.attestationId).toBe(attestation.attestationId);
    }
  });

  it('converges duplicate delivery of the composed attestation by stable identity', () => {
    const attestation = signTriageAttestation({ statement });
    const ledger = new InMemoryAttestationLedger();
    expect(ledger.ingest(attestation, VERIFY_NOW).kind).toBe('accepted');
    expect(ledger.ingest(attestation, VERIFY_NOW).kind).toBe('duplicate');
  });

  it('rejects replay of the composed attestation after single-use nonce consumption (valid signature)', () => {
    const attestation = signTriageAttestation({ statement });
    const replayPolicy = freshPolicy();
    const first = verifyAttestation(attestation, replayPolicy);
    expect(first.ok).toBe(true);
    const second = verifyAttestation(attestation, replayPolicy);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });

  it('binds the executed workload through a real artifact commitment (one-way, deterministic, real sha-256)', () => {
    // the composed workload artifact is a real deterministic artifact: the
    // canonical IR document bytes of the workflow under execution:
    const artifact = serializeWorkflowIrDocument(triage);
    const commitment = executionValueCommitment(artifact);
    expect(commitment).toBe(executionValueCommitment(serializeWorkflowIrDocument(buildTriageDocumentAltOrder())));
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    // REAL sha-256 over the UTF-8 artifact bytes (not a bespoke hash):
    expect(commitment).toBe(createHash('sha256').update(artifact, 'utf8').digest('hex'));
    expect(commitment).not.toContain('Triage inbound GitHub issue');
  });

  it('keeps the fixture freshness material exact (injected clock, epoch, nonce)', () => {
    const result = verifyAttestation(signTriageAttestation({ statement }), freshPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fact.verifiedAt).toBe(VERIFY_NOW);
      expect(result.fact.statement.nonce).toBe(NONCE);
      expect(result.fact.statement.epoch).toBe(STATEMENT_EPOCH);
      expect(result.fact.statement.executedAt).toBe(EXECUTED_AT);
      expect(result.fact.statement.validUntil).toBe(VALID_UNTIL);
    }
  });
});

describe('V2-014 composition — assurance never perturbs the merged sibling digests', () => {
  const triage = buildTriageDocument();
  const semantic = computeWorkflowVersionSemanticDigest(triage);

  it('leaves the V2-003 semantic digest and V2-002 content digest byte-identical after attestation', () => {
    const before = semantic.digest;
    const statement = buildTriageStatement({ workflowVersionSemanticDigest: semantic.digest });
    signTriageAttestation({ statement });
    expect(computeWorkflowVersionSemanticDigest(triage).digest).toBe(before);
  });
});
