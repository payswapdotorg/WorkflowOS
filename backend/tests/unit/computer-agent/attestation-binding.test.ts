/**
 * V2-008 — attestation-binding regressions (constitution §21 + registry
 * authorityRules: the runtime PRODUCES statements and signs/verifies ONLY
 * through the merged V2-014 barrel — never a second signing/verification
 * authority; a valid signature never implies authorization).
 *
 * Covers the required regressions (with a REAL Ed25519 key on a
 * DesktopHostAdapter):
 *   (a) `attestationSupport` reports supported + keyId; without a key →
 *       `{ supported: false, reason: 'no-attester-key' }` (honest absence);
 *   (b) `buildStepStatement` + `produceStepAttestation`: the statement binds
 *       workflowId/versionId/semanticDigest/runId/attemptId/stepId/nodeId
 *       and carries nonce/epoch (exact field assertions);
 *   (c) `verifyStepAttestationIndependently` with a matching policy +
 *       InMemoryReplayRegistry → ok:true with
 *       `fact.attests === 'statement_authenticity'` and neverAsserts
 *       including 'authorization';
 *   (d) TAMPER: flipping one character in `statement.action` of a parsed
 *       copy → verification fails with a typed code (ATTESTATION_DIGEST_MISMATCH
 *       or ATTESTATION_SIGNATURE_INVALID);
 *   (e) REPLAY: verifying the same attestation twice with the same
 *       replayRegistry → the second fails ATTESTATION_REPLAYED;
 *   (f) trustedAttesterKeyIds: empty list → fails
 *       (ATTESTATION_ATTESTER_UNEXPECTED); wrong key id → fails;
 *   (g) stale epoch: statement epoch < policy currentEpoch →
 *       ATTESTATION_EPOCH_STALE.
 */
import { describe, it, expect } from 'vitest';
import {
  DesktopHostAdapter,
  ScriptedDesktopEnvironment,
  buildStepStatement,
  produceStepAttestation,
  verifyStepAttestationIndependently,
  valueCommitmentOf,
  addMs,
  type AttestingComputerHost,
  type StepAttestationMaterial,
  type AgentAttestationPolicy,
} from '../../../src/computer-agent/index.js';
import { generateAttesterKeyPair, InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import type { AttestationVerification, ExecutionAttestation } from '../../../src/execution-attestation/index.js';
import { createManualClock, FIXED_STAMP } from './helpers.js';

const KEY = generateAttesterKeyPair();
const CLOCK = createManualClock();
const NOW = FIXED_STAMP; // '2026-09-01T12:00:00.000Z' — the injected production clock
const VERIFY_NOW = addMs(NOW, 30_000);
const EPOCH = 7;
const VALIDITY_MS = 300_000;

function attestingHost(): AttestingComputerHost {
  return new DesktopHostAdapter({
    nodeId: 'node_unit_attest',
    sessionToken: 'session_unit_attest',
    clock: () => CLOCK.now(),
    attestation: { supported: true, attesterKeyId: KEY.keyId },
    attesterKey: KEY,
    environment: new ScriptedDesktopEnvironment({ directories: ['reports'] }),
  }) as AttestingComputerHost;
}

const MATERIAL: StepAttestationMaterial = {
  workflowId: 'wf_unit_1',
  workflowVersionId: 'ver_unit_1',
  workflowVersionSemanticDigest: 'ab'.repeat(32),
  deploymentId: 'none',
  runId: 'run_unit_1',
  attemptNumber: 1,
  stepId: 'organize',
  executionClass: 'agentic_computer_use',
  capability: 'filesystem.write',
  action: 'agentic write of the triage report',
  inputCommitments: [valueCommitmentOf('input-a'), valueCommitmentOf('input-b')],
  outputCommitments: [valueCommitmentOf('output-a')],
  observationCommitments: [valueCommitmentOf('observation-a')],
  evidenceReferences: ['ev-1'],
};

const CONTEXT = { now: NOW, epoch: EPOCH, validityMs: VALIDITY_MS };

const MATCHING_POLICY: AgentAttestationPolicy = {
  required: false,
  trustedAttesterKeyIds: [KEY.keyId],
  requiredAssurance: 'software_signed',
  maxAgeMs: VALIDITY_MS,
};

function verifyWith(
  attestation: ExecutionAttestation,
  policy: AgentAttestationPolicy,
  options: { epoch?: number } = {},
): AttestationVerification {
  return verifyStepAttestationIndependently(attestation, MATERIAL, policy, {
    now: VERIFY_NOW,
    epoch: options.epoch ?? EPOCH,
    replayRegistry: new InMemoryReplayRegistry(),
  });
}

describe('V2-008 attestation binding (honest support declaration + production through the merged V2-014 barrel)', () => {
  it('(a) reports supported + keyId with real key material; honest no-attester-key without', () => {
    const host = attestingHost();
    expect(host.attestationSupport).toEqual({ supported: true, attesterKeyId: KEY.keyId });

    const plain = new DesktopHostAdapter({
      nodeId: 'node_unit_plain',
      sessionToken: 'session_unit_plain',
      clock: () => CLOCK.now(),
      attestation: { supported: false, reason: 'no-attester-key' },
      environment: new ScriptedDesktopEnvironment({ directories: ['reports'] }),
    });
    expect(plain.attestationSupport).toEqual({ supported: false, reason: 'no-attester-key' });

    // a declared-true attestation WITHOUT key material is still honest (the
    // adapter refuses the silent up-claim):
    const declaredWithoutKey = new DesktopHostAdapter({
      nodeId: 'node_unit_declared',
      sessionToken: 'session_unit_declared',
      clock: () => CLOCK.now(),
      attestation: { supported: true, attesterKeyId: KEY.keyId },
      environment: new ScriptedDesktopEnvironment({ directories: ['reports'] }),
    });
    expect(declaredWithoutKey.attestationSupport).toEqual({ supported: false, reason: 'no-attester-key' });
  });

  it('(b) buildStepStatement binds the exact execution identity and carries nonce/epoch', () => {
    const host = attestingHost();
    const statement = buildStepStatement(host, MATERIAL, CONTEXT);
    expect(statement.workflowId).toBe(MATERIAL.workflowId);
    expect(statement.workflowVersionId).toBe(MATERIAL.workflowVersionId);
    expect(statement.workflowVersionSemanticDigest).toBe(MATERIAL.workflowVersionSemanticDigest);
    expect(statement.deploymentId).toBe(MATERIAL.deploymentId);
    expect(statement.runId).toBe(MATERIAL.runId);
    expect(statement.attemptId).toBe(MATERIAL.attemptNumber);
    expect(statement.stepId).toBe(MATERIAL.stepId);
    expect(statement.nodeId).toBe(host.nodeId);
    expect(statement.executionClass).toBe(MATERIAL.executionClass);
    expect(statement.capability).toBe(MATERIAL.capability);
    expect(statement.action).toBe(MATERIAL.action);
    // commitments are carried (sorted, set semantics):
    expect([...statement.inputCommitments]).toEqual([...MATERIAL.inputCommitments].sort());
    expect([...statement.outputCommitments]).toEqual([...MATERIAL.outputCommitments].sort());
    expect([...statement.observationCommitments]).toEqual([...MATERIAL.observationCommitments].sort());
    expect([...statement.evidenceReferences]).toEqual([...MATERIAL.evidenceReferences].sort());
    expect(statement.causalParents).toEqual([]);
    // freshness material: the host's single-use nonce + the injected epoch:
    expect(statement.nonce).toBe(`nonce-${host.nodeId}-0001`);
    expect(statement.epoch).toBe(EPOCH);
    expect(statement.executedAt).toBe(NOW);
    expect(statement.validUntil).toBe(addMs(NOW, VALIDITY_MS));
    expect(statement.outcome).toBe('succeeded');

    // produceStepAttestation signs with the host's real Ed25519 key:
    const attestation = produceStepAttestation(host, statement, CONTEXT);
    expect(attestation.attesterKeyId).toBe(KEY.keyId);
    expect(attestation.assurance).toBe('software_signed'); // the honest baseline, never up-claimed
    expect(attestation.statement).toEqual(statement);
    expect(attestation.issuedAt).toBe(NOW);
  });
});

describe('V2-008 attestation binding (independent verification, tamper, replay, trust, epoch)', () => {
  function signedAttestation(options: { epoch?: number } = {}): ExecutionAttestation {
    const host = attestingHost();
    const statement = buildStepStatement(host, MATERIAL, {
      now: NOW,
      epoch: options.epoch ?? EPOCH,
      validityMs: VALIDITY_MS,
    });
    return produceStepAttestation(host, statement, CONTEXT);
  }

  it('(c) verifies ok with a matching policy + replay registry; the fact attests statement authenticity ONLY', () => {
    const attestation = signedAttestation();
    const result = verifyWith(attestation, MATCHING_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fact.attests).toBe('statement_authenticity');
      expect(result.fact.attestationId).toBe(attestation.attestationId);
      expect(result.fact.attesterKeyId).toBe(KEY.keyId);
      expect([...result.fact.neverAsserts]).toContain('authorization');
      expect([...result.fact.neverAsserts]).toContain('observed_effect');
      expect([...result.fact.neverAsserts]).toContain('sufficient_evidence');
      expect(result.fact.statement.stepId).toBe(MATERIAL.stepId);
      expect(result.fact.statement.runId).toBe(MATERIAL.runId);
    }
  });

  it('(d) TAMPER: one flipped character in statement.action → typed verification failure', () => {
    const attestation = signedAttestation();
    // a parsed copy (deep, independent of the signed original) with a
    // MUTABLE statement so the tamper is representable:
    const tampered = JSON.parse(JSON.stringify(attestation)) as unknown as {
      statement: { action: string };
      [key: string]: unknown;
    };
    const originalAction = tampered.statement.action;
    tampered.statement.action = `${originalAction.slice(0, -1)}X`; // flip the LAST character
    expect(tampered.statement.action).not.toBe(originalAction);

    const result = verifyWith(tampered as unknown as ExecutionAttestation, MATCHING_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // the signed envelope no longer matches the embedded statement — the
      // typed digest/signature discipline fires (either code is a correct
      // typed rejection; the pipeline checks signature before digest):
      expect(['ATTESTATION_DIGEST_MISMATCH', 'ATTESTATION_SIGNATURE_INVALID']).toContain(result.failure.code);
      expect(result.failure.code).toBe('ATTESTATION_SIGNATURE_INVALID');
    }
  });

  it('(e) REPLAY: the same attestation twice with the same replayRegistry → ATTESTATION_REPLAYED', () => {
    const attestation = signedAttestation();
    const replayRegistry = new InMemoryReplayRegistry();
    const first = verifyStepAttestationIndependently(attestation, MATERIAL, MATCHING_POLICY, {
      now: VERIFY_NOW,
      epoch: EPOCH,
      replayRegistry,
    });
    expect(first.ok).toBe(true);
    // same bytes, same clock, same epoch — but the nonce was consumed once:
    const second = verifyStepAttestationIndependently(attestation, MATERIAL, MATCHING_POLICY, {
      now: VERIFY_NOW,
      epoch: EPOCH,
      replayRegistry,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe('ATTESTATION_REPLAYED');
    }
  });

  it('(f) trustedAttesterKeyIds: an EMPTY list trusts nobody (ATTESTATION_ATTESTER_UNEXPECTED)', () => {
    const attestation = signedAttestation();
    const result = verifyWith(attestation, { required: false, trustedAttesterKeyIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
    }
  });

  it('(f) trustedAttesterKeyIds: a WRONG key id is rejected the same way (substitution rejected)', () => {
    const attestation = signedAttestation();
    const result = verifyWith(attestation, { required: false, trustedAttesterKeyIds: ['attester_some_other_key'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_ATTESTER_UNEXPECTED');
      expect(result.failure.detail).toContain(KEY.keyId);
    }
  });

  it('(g) a statement from a stale epoch is rejected ATTESTATION_EPOCH_STALE', () => {
    const attestation = signedAttestation({ epoch: EPOCH - 1 });
    const result = verifyWith(attestation, MATCHING_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('ATTESTATION_EPOCH_STALE');
    }
    // the gap (not the signature) is the cause: at the older epoch it verifies:
    const atOldEpoch = verifyWith(attestation, MATCHING_POLICY, { epoch: EPOCH - 1 });
    expect(atOldEpoch.ok).toBe(true);
  });
});
