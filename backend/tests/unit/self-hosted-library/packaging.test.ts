import { describe, it, expect } from 'vitest';
import {
  packageFirstPartyExecution,
  artifactByKind,
  type AttestationVerification,
  type FirstPartyWorkflowArtifact,
  type FirstPartyWorkflowManifest,
  type FirstPartyPinFacts,
  type PackageFirstPartyExecutionInput,
  type SelfHostingPackagingResult,
} from '../../../src/self-hosted-library/index.js';
import { InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import { createWorkflowIrBuilder, computeWorkflowVersionSemanticDigest } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import {
  makeDevEnvironment,
  buildDevStatement,
  signDevStatement,
  verifyDevAttestation,
  DEV_ATTESTER,
  DEV_ATTESTER_UNTRUSTED,
  DEV_EPOCH,
  DEV_PACKAGING_NOW,
  DEV_RUN_ID,
  DEV_TENANT,
} from './helpers.js';

/**
 * V2-013 Task 5 — the safe execution packaging battery (real cryptography).
 *
 * Proves (the frozen regressions "rejection of invalid/replayed
 * execution-proof predicates where consumed" + "workflow version pinning" +
 * the boundary/packaging composition):
 *
 *   - the CONTROL: a valid, fresh, authorized predecessor fact (REAL
 *     Ed25519 attestation, verified by the REAL V2-014 verifier, admitted
 *     through the REAL V2-015 admission) → the package is MINTED carrying
 *     the admitted predicate (satisfied parents + trusted attesters);
 *   - single-dimension mutations each deny with the CORRECT typed code:
 *     · a FAILED verification (replayed nonce through the SAME registry)
 *       → SELF_HOSTING_PROOF_PREDICATE_REJECTED carrying V2-015's
 *       ADMISSION_PREDECESSOR_UNVERIFIED with V2-014's ATTESTATION_REPLAYED
 *       verbatim;
 *     · an UNTRUSTED attester (verification fails) → predicate rejected;
 *     · the wrapper/fact identity substitution (the PR #158 Blocker-1
 *       shape) → predicate rejected with ADMISSION_EVIDENCE_IDENTITY_
 *       MISMATCH;
 *     · a MISSING evidence supply for a proof-required step →
 *       SELF_HOSTING_PROOF_STEP_UNSUPPLIED;
 *   - pin drift (the manifest pin vs the read-back pin facts) →
 *     SELF_HOSTING_PIN_DRIFT;
 *   - a weakened boundary model → SELF_HOSTING_BOUNDARY_MODEL_INVALID;
 *   - a manifest/artifact mismatch → SELF_HOSTING_MANIFEST_MISMATCH.
 */

/** The real governance boundary shape. */
function realBoundary() {
  return {
    may: ['plan its own implementation (architect-issued Work Orders)'],
    mayNot: [...CORE_SELF_HOSTING_PROHIBITIONS],
    coreProhibitions: [...CORE_SELF_HOSTING_PROHIBITIONS],
  };
}

function realTrustPolicy() {
  return {
    trustedAttesterKeyIds: [DEV_ATTESTER.keyId],
    requiredAssurance: 'software_signed' as const,
    now: DEV_PACKAGING_NOW,
    currentEpoch: DEV_EPOCH,
    maxVerificationAgeMs: 10 * 60 * 1000,
  };
}

interface PackagingFixture {
  readonly manifest: FirstPartyWorkflowManifest;
  readonly pinFacts: FirstPartyPinFacts;
  readonly scope: {
    readonly workflowId: string;
    readonly workflowVersionId: string;
    readonly workflowVersionSemanticDigest: string;
    readonly runId: string;
  };
  /** The REAL predecessor attestation (the install step, re-derivable deterministically). */
  readonly predecessor: ReturnType<typeof signDevStatement>;
  /** The baseline trusted verification of the predecessor. */
  readonly verification: AttestationVerification;
}

/**
 * The packaging baseline: the dogfooding procedure (its execute_workflow
 * step is proof-required), a REAL predecessor attestation for the run
 * step BEFORE it (install_workflow), verified fresh and trusted.
 */
async function makePackagingFixture(): Promise<PackagingFixture> {
  const { manifests } = await makeDevEnvironment();
  const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
  const pinFacts: FirstPartyPinFacts = {
    organizationId: DEV_TENANT,
    installationId: manifest.installationId,
    workflowId: manifest.workflowId,
    versionId: manifest.versionId,
    versionNumber: manifest.versionNumber,
    contentDigest: manifest.contentDigest,
  };
  const scope = {
    workflowId: manifest.workflowId,
    workflowVersionId: manifest.versionId,
    workflowVersionSemanticDigest: manifest.semanticDigest.digest,
    runId: DEV_RUN_ID,
  };
  const predecessor = signDevStatement(
    buildDevStatement(scope, {
      stepId: 'install_workflow',
      nodeId: 'node_dev_self_hosted_worker',
      action: 'Install the first-party workflow through the universal installation authority (version-pinned)',
      nonce: 'challenge-dev-dogfood-install-0001',
    }),
  );
  const verification = verifyDevAttestation(predecessor, scope);
  return { manifest, pinFacts, scope, predecessor, verification };
}

function baselineInput(
  fixture: PackagingFixture,
  verification: AttestationVerification = fixture.verification,
): PackageFirstPartyExecutionInput {
  return {
    artifact: artifactByKind('dogfooding')!,
    manifest: fixture.manifest,
    boundary: realBoundary(),
    pinFacts: fixture.pinFacts,
    executionScope: { runId: DEV_RUN_ID },
    trustPolicy: realTrustPolicy(),
    proofSteps: [
      {
        stepId: 'execute_workflow',
        declaredParents: [fixture.predecessor.executionDigest.digest],
        predecessorEvidence: [
          { executionDigest: fixture.predecessor.executionDigest.digest, verification },
        ],
      },
    ],
  };
}

function expectDeniedCode(result: SelfHostingPackagingResult, code: string) {
  if (result.packaged) {
    throw new Error(`expected denial ${code}, got a minted package`);
  }
  expect(result.failure.code).toBe(code);
  return result.failure;
}

describe('V2-013 execution packaging — the control (valid, fresh, authorized proof predicate)', () => {
  it('a REAL verified predecessor fact → the package is minted with the admitted predicate', async () => {
    const fixture = await makePackagingFixture();
    expect(fixture.verification.ok).toBe(true);
    const result = packageFirstPartyExecution(baselineInput(fixture));
    if (!result.packaged) {
      throw new Error(`expected packaged, got ${result.failure.code}: ${result.failure.detail}`);
    }
    expect(result.package.kind).toBe('dogfooding');
    expect(result.package.runId).toBe(DEV_RUN_ID);
    expect(result.package.versionId).toBe(fixture.manifest.versionId);
    expect(result.package.boundaryCoreProhibitions).toEqual(CORE_SELF_HOSTING_PROHIBITIONS);
    expect(result.package.admittedProofSteps).toHaveLength(1);
    expect(result.package.admittedProofSteps[0]!.stepId).toBe('execute_workflow');
    expect(result.package.admittedProofSteps[0]!.satisfiedParents).toEqual([fixture.predecessor.executionDigest.digest]);
    expect(result.package.admittedProofSteps[0]!.trustedAttesterKeyIds).toEqual([DEV_ATTESTER.keyId]);
  });
});

describe('V2-013 execution packaging — invalid/replayed proof predicates are rejected typed', () => {
  it("a REPLAYED predecessor (the same nonce verified twice through one registry) → predicate rejected with V2-014's replay code carried verbatim", async () => {
    const fixture = await makePackagingFixture();
    // first verification consumes the nonce; the SECOND (the replay) is
    // refused typed by V2-014 through the SAME registry
    const registry = new InMemoryReplayRegistry();
    const first = verifyDevAttestation(fixture.predecessor, fixture.scope, { replayRegistry: registry });
    expect(first.ok).toBe(true);
    const replayed = verifyDevAttestation(fixture.predecessor, fixture.scope, { replayRegistry: registry });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.failure.code).toBe('ATTESTATION_REPLAYED');
    }
    const result = packageFirstPartyExecution(baselineInput(fixture, replayed));
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.stepId).toBe('execute_workflow');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
    expect(failure.admissionFailure?.verifierFailureCode).toBe('ATTESTATION_REPLAYED');
  });

  it("an UNTRUSTED attester's attestation (verification fails) → predicate rejected (the empty-trust rule holds through packaging)", async () => {
    const fixture = await makePackagingFixture();
    // sign the SAME predecessor statement with the UNTRUSTED key
    const { signExecutionAttestation } = await import('../../../src/execution-attestation/index.js');
    const foreign = signExecutionAttestation({
      statement: fixture.predecessor.statement,
      attesterPrivateKey: DEV_ATTESTER_UNTRUSTED.privateKey,
      attesterPublicKeyDer: DEV_ATTESTER_UNTRUSTED.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: '2026-09-03T08:00:01.000Z',
    });
    // the verification policy trusts ONLY DEV_ATTESTER → typed failure
    const verification = verifyDevAttestation(foreign, fixture.scope);
    expect(verification.ok).toBe(false);
    const result = packageFirstPartyExecution(baselineInput(fixture, verification));
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_PREDECESSOR_UNVERIFIED');
  });

  it('the wrapper/fact identity substitution (the PR #158 Blocker-1 shape) → predicate rejected with the identity-mismatch code', async () => {
    const fixture = await makePackagingFixture();
    expect(fixture.verification.ok).toBe(true);
    // the SAME verified fact retained under a SUBSTITUTED wrapper digest,
    // the declared parent following the wrapper (the attack shape)
    const substituted = 'ab'.repeat(32);
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [substituted],
          predecessorEvidence: [{ executionDigest: substituted, verification: fixture.verification }],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PREDICATE_REJECTED');
    expect(failure.admissionFailure?.code).toBe('ADMISSION_EVIDENCE_IDENTITY_MISMATCH');
  });

  it('a MISSING evidence supply for the proof-required step → SELF_HOSTING_PROOF_STEP_UNSUPPLIED (absence never satisfies)', async () => {
    const fixture = await makePackagingFixture();
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_STEP_UNSUPPLIED');
    expect(failure.stepId).toBe('execute_workflow');
  });
});

describe('V2-013 execution packaging — pin drift, boundary, and manifest correspondence', () => {
  it('pin drift (the read-back pin no longer matches the manifest) → SELF_HOSTING_PIN_DRIFT', async () => {
    const fixture = await makePackagingFixture();
    const drifted: FirstPartyPinFacts = {
      ...fixture.pinFacts,
      versionId: 'wfwv-moved-silently',
      versionNumber: 2,
      contentDigest: 'digest-moved',
    };
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      pinFacts: drifted,
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PIN_DRIFT');
    expect(failure.expected).toBe(`${fixture.manifest.workflowId}@${fixture.manifest.versionId}`);
    expect(failure.actual).toBe(`${fixture.manifest.workflowId}@wfwv-moved-silently`);
  });

  it('a WEAKENED boundary model → SELF_HOSTING_BOUNDARY_MODEL_INVALID (the packaging never opens on governance weakening)', async () => {
    const fixture = await makePackagingFixture();
    const weakened = {
      may: ['plan its own implementation'],
      mayNot: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
      coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
    };
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      boundary: weakened,
    });
    expectDeniedCode(result, 'SELF_HOSTING_BOUNDARY_MODEL_INVALID');
  });

  it('a manifest/artifact mismatch (the WRONG manifest for the artifact) → SELF_HOSTING_MANIFEST_MISMATCH', async () => {
    const fixture = await makePackagingFixture();
    // supply the TESTING manifest with the DOGFOODING artifact
    const { manifests } = await makeDevEnvironment();
    const testingManifest = manifests.find((m) => m.kind === 'testing')!;
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      manifest: { ...testingManifest, installationId: fixture.manifest.installationId },
    });
    expectDeniedCode(result, 'SELF_HOSTING_MANIFEST_MISMATCH');
  });
});

// =============================================================================
// The PR #160 Blocker-1 correction — the predecessor binding to the
// authoritative WorkflowIR predecessor edges.
//
// The architect's finding: `packageFirstPartyExecution()` trusted the
// caller-supplied `declaredParents` without binding them to the WorkflowIR
// document's authoritative predecessor edges — a valid attestation for an
// UNRELATED execution could therefore satisfy a proof-required step.
//
// Every regression below uses a REAL, fresh, trusted, VERIFIED Ed25519
// attestation (the exact class of evidence the hole admitted) and proves
// the binding denies typed.
// =============================================================================

describe('V2-013 execution packaging — the predecessor binding to the authoritative WorkflowIR edges (PR #160 Blocker-1)', () => {
  it('a VALID verified attestation for an UNRELATED step of the same workflow → the binding denies (a foreign step never satisfies the predicate)', async () => {
    const fixture = await makePackagingFixture();
    // a REAL attestation for `record_evidence` — a step of the SAME workflow
    // and the SAME run scope, but NOT a WorkflowIR-declared predecessor of
    // the proof-required step `execute_workflow`
    const unrelated = signDevStatement(
      buildDevStatement(fixture.scope, {
        stepId: 'record_evidence',
        nodeId: 'node_dev_self_hosted_worker',
        action: 'Record the dogfooding evidence (a NON-predecessor step of execute_workflow)',
        nonce: 'challenge-dev-dogfood-unrelated-0002',
      }),
    );
    const verification = verifyDevAttestation(unrelated, fixture.scope);
    expect(verification.ok).toBe(true); // the evidence itself is valid, fresh, authorized
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [unrelated.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: unrelated.executionDigest.digest, verification },
          ],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED');
    expect(failure.stepId).toBe('execute_workflow');
    expect(failure.offending).toBe('record_evidence');
    expect(failure.detail).toContain('install_workflow');
  });

  it('a VALID verified attestation for the predecessor step but a FOREIGN workflowId (the version-scope dimensions V2-015 already binds left equal) → the binding denies (fail-closed on the one identity dimension the admission does not check)', async () => {
    const fixture = await makePackagingFixture();
    // the right stepId, run, version and semantic digest (everything V2-015's
    // admission binds) — but the statement claims a FOREIGN workflowId, the
    // one scope dimension the V2-015 binding check does not cover
    const foreignScope = {
      workflowId: 'wfw-foreign-workflow',
      workflowVersionId: fixture.scope.workflowVersionId,
      workflowVersionSemanticDigest: fixture.scope.workflowVersionSemanticDigest,
      runId: fixture.scope.runId,
    };
    const foreign = signDevStatement(
      buildDevStatement(foreignScope, {
        stepId: 'install_workflow',
        nodeId: 'node_dev_self_hosted_worker',
        action: 'Install a foreign workflow through the universal installation authority',
        nonce: 'challenge-dev-dogfood-foreign-0003',
      }),
    );
    const verification = verifyDevAttestation(foreign, foreignScope);
    expect(verification.ok).toBe(true); // verified under ITS OWN (foreign) bindings
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [foreign.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: foreign.executionDigest.digest, verification },
          ],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED');
    expect(failure.stepId).toBe('execute_workflow');
    expect(failure.offending).toContain('wfw-foreign-workflow');
  });

  it('an UNCOVERED WorkflowIR-declared predecessor (a 2-predecessor artifact, the supply covers only one) → the binding denies (the declared set may not be narrower than the IR structure)', async () => {
    // a test-local artifact whose proof-required step has TWO IR-declared
    // predecessors (install_workflow AND verify_environment), authored
    // through the SAME V2-003 public builder the module itself uses
    const artifact = twoPredecessorDogfoodingArtifact();
    const customManifest: FirstPartyWorkflowManifest = {
      kind: 'dogfooding',
      slug: 'wfos-dev-dogfooding',
      workflowId: 'wfw-custom-two-predecessors',
      versionId: 'wfwv-custom-two-pred-1',
      versionNumber: 1,
      contentDigest: 'digest-custom-two-pred-1',
      semanticDigest: computeWorkflowVersionSemanticDigest(artifact.document),
      installationId: 'wfin-custom-two-pred-1',
    };
    const customPinFacts: FirstPartyPinFacts = {
      organizationId: DEV_TENANT,
      installationId: customManifest.installationId,
      workflowId: customManifest.workflowId,
      versionId: customManifest.versionId,
      versionNumber: customManifest.versionNumber,
      contentDigest: customManifest.contentDigest,
    };
    const customScope = {
      workflowId: customManifest.workflowId,
      workflowVersionId: customManifest.versionId,
      workflowVersionSemanticDigest: customManifest.semanticDigest.digest,
      runId: DEV_RUN_ID,
    };
    // a REAL verified attestation for ONE of the two IR-declared predecessors
    const partial = signDevStatement(
      buildDevStatement(customScope, {
        stepId: 'install_workflow',
        nodeId: 'node_dev_self_hosted_worker',
        action: 'Install the first-party workflow through the universal installation authority (version-pinned)',
        nonce: 'challenge-dev-dogfood-partial-0004',
      }),
    );
    const verification = verifyDevAttestation(partial, customScope);
    expect(verification.ok).toBe(true);
    const result = packageFirstPartyExecution({
      artifact,
      manifest: customManifest,
      boundary: realBoundary(),
      pinFacts: customPinFacts,
      executionScope: { runId: DEV_RUN_ID },
      trustPolicy: realTrustPolicy(),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [partial.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: partial.executionDigest.digest, verification },
          ],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED');
    expect(failure.stepId).toBe('execute_workflow');
    expect(failure.offending).toBe('verify_environment');
  });

  it('a VALID verified attestation for a NON-predecessor step carried in the evidence set (even undeclared) → fail-closed (the whole evidence set must be IR-bound)', async () => {
    const fixture = await makePackagingFixture();
    // the legitimate predecessor supply (declared + admitted)…
    const unrelated = signDevStatement(
      buildDevStatement(fixture.scope, {
        stepId: 'record_evidence',
        nodeId: 'node_dev_self_hosted_worker',
        action: 'Record the dogfooding evidence (a NON-predecessor step, carried undeclared)',
        nonce: 'challenge-dev-dogfood-extra-0005',
      }),
    );
    const unrelatedVerification = verifyDevAttestation(unrelated, fixture.scope);
    expect(unrelatedVerification.ok).toBe(true);
    // …plus a foreign VERIFIED fact in the evidence set that is NOT declared
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [fixture.predecessor.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: fixture.predecessor.executionDigest.digest, verification: fixture.verification },
            { executionDigest: unrelated.executionDigest.digest, verification: unrelatedVerification },
          ],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED');
    expect(failure.offending).toBe('record_evidence');
  });

  it('a MISSING fact stepId (a statement with no step identity) → the binding denies (fail-closed on the absent binding)', async () => {
    const fixture = await makePackagingFixture();
    // a statement whose stepId is absent: the fact attests no step identity,
    // so it cannot bind ANY WorkflowIR predecessor edge
    const unstepped = buildDevStatement(fixture.scope, {
      stepId: 'install_workflow',
      nodeId: 'node_dev_self_hosted_worker',
      action: 'Install the first-party workflow (step identity stripped for the fail-closed experiment)',
      nonce: 'challenge-dev-dogfood-nostep-0006',
    });
    const statement = { ...unstepped, stepId: undefined } as typeof unstepped;
    const attestation = signDevStatement(statement);
    const verification = verifyDevAttestation(attestation, { ...fixture.scope });
    expect(verification.ok).toBe(true);
    const result = packageFirstPartyExecution({
      ...baselineInput(fixture),
      proofSteps: [
        {
          stepId: 'execute_workflow',
          declaredParents: [attestation.executionDigest.digest],
          predecessorEvidence: [
            { executionDigest: attestation.executionDigest.digest, verification },
          ],
        },
      ],
    });
    const failure = expectDeniedCode(result, 'SELF_HOSTING_PROOF_PARENT_BINDING_VIOLATED');
    expect(failure.stepId).toBe('execute_workflow');
  });
});

// ---------------------------------------------------------------------------
// The 2-predecessor test artifact (authored through the V2-003 public
// builder — the same authority the module's own artifacts use)
// ---------------------------------------------------------------------------

function twoPredecessorDogfoodingArtifact(): FirstPartyWorkflowArtifact {
  const document: WorkflowIrDocument = createWorkflowIrBuilder()
    .withStart('install_workflow')
    .addWorkflowInput({ name: 'procedureKind', type: { kind: 'string' } })
    .addNode(apiStep('install_workflow'))
    .addNode(apiStep('verify_environment'))
    .addNode(executeStep())
    .addEdge({ from: 'install_workflow', to: 'verify_environment', on: 'success' })
    .addEdge({ from: 'install_workflow', to: 'execute_workflow', on: 'success' })
    .addEdge({ from: 'verify_environment', to: 'execute_workflow', on: 'success' })
    .build();
  return {
    kind: 'dogfooding',
    slug: 'wfos-dev-dogfooding',
    name: 'WorkflowOS dogfooding procedure (two-predecessor test artifact)',
    description: 'A test-local dogfooding artifact whose proof-required step declares two WorkflowIR predecessors.',
    document,
    executionPolicy: { proofRequiredSteps: ['execute_workflow'] },
  };
}

function apiStep(id: string): WorkflowNode {
  return {
    id,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'workflow.execute' },
    capabilityRequirements: ['workflow.execute'],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'done', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}

function executeStep(): WorkflowNode {
  return {
    id: 'execute_workflow',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: 'Execute the installed workflow end-to-end through the real execution authorities' },
    capabilityRequirements: ['workflow.execute', 'filesystem.read'],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'done', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}
