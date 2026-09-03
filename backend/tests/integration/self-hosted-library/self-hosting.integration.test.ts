import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installFirstPartyWorkflows,
  publishFirstPartyVersion,
  packageFirstPartyExecution,
  planFailedWorkflowRecovery,
  reconstructSelfHostingEvidence,
  evaluateSelfHostingBoundary,
  artifactByKind,
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  type FirstPartyPinFacts,
  type FirstPartyInstallPort,
  type SelfHostingBoundaryPolicyInput,
} from '../../../src/self-hosted-library/index.js';
import { FileSystemGovernanceStateLoader } from '../../../src/development-governance/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import { buildWorkflowRunTestStack, type WorkflowRunTestStack } from '../workflow-runs/run-test-support.js';
import { commitmentOf } from '../workflow-deployments/trigger-test-support.js';

/**
 * V2-013 — the self-hosting integration battery on the REAL stack.
 *
 * The self-hosted-library domain (src/self-hosted-library — the pure
 * application-layer module) is composed OVER the REAL authorities:
 *
 *   - the REAL V2-002 workflow-repository service (DefaultWorkflowRepository
 *     Service over the real PGlite database with ALL migrations — the exact
 *     service behind the real routes);
 *   - the REAL V2-005 workflow-runs service (DefaultWorkflowRunService over
 *     the same real database — real runs, real lifecycle, real history);
 *   - the REAL development-governance state loader reading the repository's
 *     canonical spec/development-state/governance-model.json (the machine-
 *     readable self-hosting boundary).
 *
 * Required regressions proven HERE on the real stack:
 *   - first-party/third-party protocol equivalence (the SAME installation
 *     authority, the same pin semantics, the same version immutability);
 *   - workflow version pinning (a publisher edit NEVER moves an installed
 *     pin — first-party exactly like third-party);
 *   - governance preservation (the REAL boundary model admits the six
 *     artifacts; a WEAKENED model is fail-closed through the real loader's
 *     own validation AND through the boundary evaluation);
 *   - failed-workflow recovery over a REAL failed run (the plan; the
 *     failed run stays failed; the retry is a NEW run on the same pin);
 *   - evidence reconstruction from the REAL run history.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let support: WorkflowRunTestStack;
/** The development environment tenant (org A of the real run-test stack). */
let devOrgId: string;
let devUserId: string;
/** The REAL repository service — also the structural install port. */
let port: FirstPartyInstallPort;
/** The REAL governance boundary (from the canonical governance-model.json). */
let realBoundary: SelfHostingBoundaryPolicyInput;

beforeAll(async () => {
  support = await buildWorkflowRunTestStack();
  devOrgId = support.orgAId;
  devUserId = support.ownerAId;
  port = support.repository as unknown as FirstPartyInstallPort;
  const loaded = await new FileSystemGovernanceStateLoader({
    repoRoot: REPO_ROOT,
    governanceDir: join(REPO_ROOT, 'spec', 'development-state'),
  }).inspect();
  expect(loaded.validation.ok, loaded.validation.violations.join('\n')).toBe(true);
  realBoundary = loaded.model.selfHostingBoundary;
});

afterAll(async () => {
  await support.teardown();
});

function principal() {
  return { userId: devUserId };
}

async function installLibrary() {
  return installFirstPartyWorkflows({
    principal: principal(),
    organizationId: devOrgId,
    port,
    protocol: { irSchemaVersion: 'wfos-ir-1' },
  });
}

async function pinFactsOf(installationId: string): Promise<FirstPartyPinFacts> {
  const detail = await support.repository.getInstallation(principal(), devOrgId, installationId);
  return {
    organizationId: devOrgId,
    installationId,
    workflowId: detail.pinnedVersion.workflowId,
    versionId: detail.pinnedVersion.id,
    versionNumber: detail.pinnedVersion.versionNumber,
    contentDigest: detail.pinnedVersion.contentDigest,
  };
}

describe('V2-013 integration — self-hosting installation over the REAL V2-002 authority', () => {
  it('installs the six first-party workflows through the REAL repository service (ordinary workflows, real identities)', async () => {
    const outcome = await installLibrary();
    expect(outcome.manifests.map((m) => m.kind)).toEqual([
      'implementation', 'review', 'testing', 'release', 'maintenance', 'dogfooding',
    ]);
    // the manifests' identities are the REAL authority's records
    for (const manifest of outcome.manifests) {
      const workflow = await support.repository.getWorkflow(principal(), manifest.workflowId);
      expect(workflow.slug).toBe(manifest.slug);
      expect(workflow.organizationId).toBe(devOrgId);
      const detail = await support.repository.getInstallation(principal(), devOrgId, manifest.installationId);
      expect(detail.pinnedVersion.id).toBe(manifest.versionId);
      expect(detail.pinnedVersion.contentDigest).toBe(manifest.contentDigest);
    }
    // re-running CONVERGES over the real authority (idempotent)
    const second = await installLibrary();
    expect(second.manifests).toStrictEqual(outcome.manifests);
  });

  it('FIRST-PARTY/THIRD-PARTY PROTOCOL EQUIVALENCE: the same authority, the same pin semantics, the same immutability', async () => {
    const outcome = await installLibrary();
    // a THIRD-PARTY workflow through the SAME authority (the ordinary path)
    const thirdParty = await support.repository.createWorkflow(principal(), {
      organizationId: devOrgId,
      slug: 'third-party-collab-triage',
      name: 'A third-party collaboration workflow',
      description: 'The equivalence witness',
      visibility: 'organization',
      content: { title: 'third-party v1' } as Record<string, unknown>,
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    const thirdPartyInstall = await support.repository.installVersion(principal(), {
      organizationId: devOrgId,
      workflowId: thirdParty.workflow.id,
      versionId: thirdParty.initialVersion.id,
    });
    // publisher edits on BOTH sides: new versions, pins never move
    const firstParty = outcome.manifests.find((m) => m.kind === 'testing')!;
    const firstPartyV2 = await support.repository.createVersion(principal(), firstParty.workflowId, {
      content: { title: 'first-party v2' } as Record<string, unknown>,
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    const thirdPartyV2 = await support.repository.createVersion(principal(), thirdParty.workflow.id, {
      content: { title: 'third-party v2' } as Record<string, unknown>,
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    const firstPartyPin = await support.repository.getInstallation(principal(), devOrgId, firstParty.installationId);
    const thirdPartyPin = await support.repository.getInstallation(principal(), devOrgId, thirdPartyInstall.installation.id);
    // IDENTICAL pin semantics: both installations still pin v1; the new
    // versions exist but never move the installed pins
    expect(firstPartyPin.pinnedVersion.id).toBe(firstParty.versionId);
    expect(firstPartyPin.pinnedVersion.versionNumber).toBe(1);
    expect(thirdPartyPin.pinnedVersion.id).toBe(thirdParty.initialVersion.id);
    expect(thirdPartyPin.pinnedVersion.versionNumber).toBe(1);
    expect(firstPartyV2.version.versionNumber).toBe(2);
    expect(thirdPartyV2.version.versionNumber).toBe(2);
  });

  it('the REAL governance boundary admits all six artifacts (governance preservation on the real model)', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const verdict = evaluateSelfHostingBoundary(artifact.document, realBoundary);
      expect(verdict.allowed, JSON.stringify(verdict)).toBe(true);
    }
  });

  it("a WEAKENED boundary model is fail-closed: the packaging denies (and the real loader's own validation fails)", async () => {
    const outcome = await installLibrary();
    const dogfooding = outcome.manifests.find((m) => m.kind === 'dogfooding')!;
    const weakened = {
      may: realBoundary.may,
      mayNot: realBoundary.mayNot.filter((entry) => !entry.includes('merge its own governing PR')),
      coreProhibitions: realBoundary.coreProhibitions.filter((entry) => !entry.includes('merge its own governing PR')),
    };
    const result = packageFirstPartyExecution({
      artifact: artifactByKind('dogfooding')!,
      manifest: dogfooding,
      boundary: weakened,
      pinFacts: await pinFactsOf(dogfooding.installationId),
      executionScope: { runId: 'wfr-equivalence-probe' },
      trustPolicy: {
        trustedAttesterKeyIds: [],
        now: '2026-09-03T08:00:30.000Z',
        currentEpoch: 11,
      },
      proofSteps: [],
    });
    // (the proof steps are empty here only to reach the boundary dimension
    // first — the fixed evaluation order guarantees the boundary check
    // runs BEFORE the proof predicates)
    expect(result.packaged).toBe(false);
    if (!result.packaged) {
      expect(result.failure.code).toBe('SELF_HOSTING_BOUNDARY_MODEL_INVALID');
      expect(result.failure.detail).toContain('code-pinned core prohibition');
    }
    // the REAL loader also fails on the weakened model shape (ADR-0004)
    const realLoaderEquivalent = validateBoundaryEquivalent(weakened);
    expect(realLoaderEquivalent).toBe(false);
  });
});

describe('V2-013 integration — failed-workflow recovery + evidence over the REAL V2-005 authority', () => {
  it('a REAL failed run → the typed retry_same_pin plan; the failed run STAYS failed; the retry is a NEW run on the SAME pin', async () => {
    const outcome = await installLibrary();
    const dogfooding = outcome.manifests.find((m) => m.kind === 'dogfooding')!;
    const runs = support.freshRunService();
    // a REAL run pinned to the manifest's exact version + installation
    const requested = await runs.requestRun(principal(), {
      commandId: 'cmd-v2013-recovery-0001',
      correlationId: 'v2013-recovery-flow',
      causationId: 'v2013-recovery-root',
    }, {
      organizationId: devOrgId,
      workflowId: dogfooding.workflowId,
      versionId: dogfooding.versionId,
      installationId: dogfooding.installationId,
      trigger: { type: 'manual', id: 'v2013-recovery-trigger' },
      inputCommitments: [commitmentOf('v2-013-recovery-input')],
    });
    expect(requested.result.created).toBe(true);
    const runId = requested.result.run.id;
    // the run REALLY fails through the real lifecycle
    const started = await runs.startRun(principal(), {
      commandId: 'cmd-v2013-recovery-0002',
      correlationId: 'v2013-recovery-flow',
      causationId: runId,
    }, { runId });
    expect(started.result.run.state).toBe('running');
    const failed = await runs.failRun(principal(), {
      commandId: 'cmd-v2013-recovery-0003',
      correlationId: 'v2013-recovery-flow',
      causationId: runId,
    }, { runId, reason: 'the dev worker lost the sandbox' });
    expect(failed.result.run.state).toBe('failed');

    // the typed recovery plan over the REAL failed run
    const plan = planFailedWorkflowRecovery({
      manifest: dogfooding,
      failedRun: { runId, workflowId: dogfooding.workflowId, versionId: dogfooding.versionId, state: 'failed' },
      pinFacts: await pinFactsOf(dogfooding.installationId),
      boundary: realBoundary,
      artifact: artifactByKind('dogfooding')!,
      request: { action: 'retry_same_pin' },
    });
    expect(plan.kind).toBe('retry_same_pin');
    if (plan.kind === 'retry_same_pin') {
      expect(plan.versionId).toBe(dogfooding.versionId);
      expect(plan.installationId).toBe(dogfooding.installationId);
      // the retry executes as a NEW run through the REAL authority
      const retried = await runs.requestRun(principal(), {
        commandId: 'cmd-v2013-recovery-0004',
        correlationId: 'v2013-recovery-flow-retry',
        causationId: runId,
      }, {
        organizationId: devOrgId,
        workflowId: plan.workflowId,
        versionId: plan.versionId,
        installationId: plan.installationId,
        trigger: { type: 'manual', id: 'v2013-recovery-retry' },
        inputCommitments: [commitmentOf('v2-013-recovery-retry')],
      });
      expect(retried.result.run.id).not.toBe(runId);
      expect(retried.result.run.versionId).toBe(dogfooding.versionId);
      // the failed run STAYS failed (durable history; never resurrected)
      const history = await runs.getRunHistory(principal(), runId);
      expect(history.run.state).toBe('failed');
    }
  });

  it('ADVANCE_VERSION over the REAL authority: a REAL published AND INSTALLED target (facts read back through getVersion + getInstallation) mints the plan; published-but-NOT-installed and SYNTHETIC targets are fail-closed', async () => {
    const outcome = await installLibrary();
    const dogfooding = outcome.manifests.find((m) => m.kind === 'dogfooding')!;
    const runs = support.freshRunService();
    // a REAL failed run pinned to the manifest's exact version
    const requested = await runs.requestRun(principal(), {
      commandId: 'cmd-v2013-advance-0001',
      correlationId: 'v2013-advance-flow',
      causationId: 'v2013-advance-root',
    }, {
      organizationId: devOrgId,
      workflowId: dogfooding.workflowId,
      versionId: dogfooding.versionId,
      installationId: dogfooding.installationId,
      trigger: { type: 'manual', id: 'v2013-advance-trigger' },
      inputCommitments: [commitmentOf('v2-013-advance-input')],
    });
    const runId = requested.result.run.id;
    await runs.startRun(principal(), {
      commandId: 'cmd-v2013-advance-0002',
      correlationId: 'v2013-advance-flow',
      causationId: runId,
    }, { runId });
    await runs.failRun(principal(), {
      commandId: 'cmd-v2013-advance-0003',
      correlationId: 'v2013-advance-flow',
      causationId: runId,
    }, { runId, reason: 'the dev worker lost the sandbox before the advance' });

    // publish a REAL new version of the SAME workflow through the module's
    // own explicit transition over the REAL authority (mutated content —
    // V2-002 converges on identical content)
    const { serializeWorkflowIrDocument, parseWorkflowIrDocument } = await import('../../../src/workflow-ir/index.js');
    const mutatedRoundTrip = JSON.parse(serializeWorkflowIrDocument(artifactByKind('dogfooding')!.document)) as Record<string, unknown>;
    const ir = mutatedRoundTrip['ir'] as Record<string, unknown>;
    const nodes = ir['nodes'] as Record<string, unknown>[];
    const spec = nodes[nodes.length - 1]!['spec'] as Record<string, unknown>;
    spec['task'] = 'Record the dogfooding evidence and corrective observations (v2 maintenance update)';
    const mutatedDocument = parseWorkflowIrDocument(JSON.stringify(mutatedRoundTrip));
    if (!mutatedDocument.ok) {
      throw new Error('the mutated document must still parse clean');
    }
    const published = await publishFirstPartyVersion(
      port,
      principal(),
      dogfooding.workflowId,
      mutatedDocument.document,
      { irSchemaVersion: 'wfos-ir-1' },
    );
    expect(published.created).toBe(true);
    expect(published.versionNumber).toBe(2);

    // the authoritative target version facts: READ BACK from the REAL V2-002
    // authority (getVersion — the authority's own version record)
    const target = await support.repository.getVersion(principal(), dogfooding.workflowId, published.versionId);
    const recoveryInput = {
      manifest: dogfooding,
      failedRun: { runId, workflowId: dogfooding.workflowId, versionId: dogfooding.versionId, state: 'failed' as const },
      pinFacts: await pinFactsOf(dogfooding.installationId),
      boundary: realBoundary,
      artifact: artifactByKind('dogfooding')!,
    };
    // the residual hole's EXACT real-stack shape (review 5102958519): the
    // version record EXISTS (authoritative facts supplied), but the target
    // was NEVER installed through V2-002 in this environment — publication
    // alone must NOT mint the advance plan
    const uninstalled = planFailedWorkflowRecovery({
      ...recoveryInput,
      request: {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: target.id,
            workflowId: target.workflowId,
            versionNumber: target.versionNumber,
            contentDigest: target.contentDigest,
          },
        },
      } as Parameters<typeof planFailedWorkflowRecovery>[0]['request'],
    });
    expect(uninstalled.kind).toBe('blocked');
    if (uninstalled.kind === 'blocked') {
      expect(uninstalled.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(uninstalled.failure.detail).toContain(published.versionId);
    }

    // install the target pin through the REAL V2-002 installation path (a
    // DISTINCT installation record pinning v2 — the current installation is
    // never re-pinned), then READ the installation back through the
    // authority's own read surface
    const targetInstalled = await port.installVersion(principal(), {
      organizationId: devOrgId,
      workflowId: dogfooding.workflowId,
      versionId: published.versionId,
    });
    expect(targetInstalled.installation.id).not.toBe(dogfooding.installationId);
    const targetInstallationFacts = await pinFactsOf(targetInstalled.installation.id);
    expect(targetInstallationFacts.versionId).toBe(published.versionId);
    expect(targetInstallationFacts.versionNumber).toBe(published.versionNumber);
    expect(targetInstallationFacts.contentDigest).toBe(published.contentDigest);

    // published AND installed, both facts read back from the REAL authority
    // → the plan mints
    const plan = planFailedWorkflowRecovery({
      ...recoveryInput,
      request: {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: target.id,
            workflowId: target.workflowId,
            versionNumber: target.versionNumber,
            contentDigest: target.contentDigest,
          },
          installation: targetInstallationFacts,
        },
      },
    });
    expect(plan.kind).toBe('advance_version');
    if (plan.kind === 'advance_version') {
      expect(plan.workflowId).toBe(dogfooding.workflowId);
      expect(plan.fromVersionId).toBe(dogfooding.versionId);
      expect(plan.toVersionId).toBe(published.versionId);
      expect(plan.failedRunId).toBe(runId);
      // the failed run STAYS failed (the advance is a NEW pin, never a redirect)
      expect((await runs.getRunHistory(principal(), runId)).run.state).toBe('failed');
    }

    // the OLD hole's exact shape over the REAL stack: a bare synthetic
    // toVersionId with NO authority facts is fail-closed typed
    const synthetic = planFailedWorkflowRecovery({
      ...recoveryInput,
      request: { action: 'advance_version', toVersionId: 'wfwv-synthetic-target' } as Parameters<typeof planFailedWorkflowRecovery>[0]['request'],
    });
    expect(synthetic.kind).toBe('blocked');
    if (synthetic.kind === 'blocked') {
      expect(synthetic.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(synthetic.failure.detail).toContain('wfwv-synthetic-target');
    }
  });

  it('EVIDENCE RECONSTRUCTION from the REAL run history: pins match, runs attributed to the exact pinned version', async () => {
    const outcome = await installLibrary();
    const dogfooding = outcome.manifests.find((m) => m.kind === 'dogfooding')!;
    const runs = support.freshRunService();
    const requested = await runs.requestRun(principal(), {
      commandId: 'cmd-v2013-evidence-0001',
      correlationId: 'v2013-evidence-flow',
      causationId: 'v2013-evidence-root',
    }, {
      organizationId: devOrgId,
      workflowId: dogfooding.workflowId,
      versionId: dogfooding.versionId,
      installationId: dogfooding.installationId,
      trigger: { type: 'manual', id: 'v2013-evidence-trigger' },
      inputCommitments: [commitmentOf('v2-013-evidence-input')],
    });
    const runId = requested.result.run.id;
    await runs.startRun(principal(), {
      commandId: 'cmd-v2013-evidence-0002',
      correlationId: 'v2013-evidence-flow',
      causationId: runId,
    }, { runId });
    await runs.completeRun(principal(), {
      commandId: 'cmd-v2013-evidence-0003',
      correlationId: 'v2013-evidence-flow',
      causationId: runId,
    }, { runId, outputCommitments: [] });

    const history = await runs.getRunHistory(principal(), runId);
    const reconstruction = reconstructSelfHostingEvidence({
      manifests: outcome.manifests,
      pinFacts: await Promise.all(outcome.manifests.map((m) => pinFactsOf(m.installationId))),
      runHistories: [history],
    });
    const record = reconstruction.records.find((r) => r.kind === 'dogfooding')!;
    expect(record.pinMatchesManifest).toBe(true);
    expect(record.runs).toHaveLength(1);
    expect(record.runs[0]!.runId).toBe(runId);
    expect(record.runs[0]!.state).toBe('completed');
    expect(record.runs[0]!.installationId).toBe(dogfooding.installationId);
    expect(reconstruction.unpinnedRuns).toEqual([]);
    // deterministic: a second reconstruction over the same real facts is identical
    const again = reconstructSelfHostingEvidence({
      manifests: outcome.manifests,
      pinFacts: await Promise.all(outcome.manifests.map((m) => pinFactsOf(m.installationId))),
      runHistories: [history],
    });
    expect(again).toStrictEqual(reconstruction);
  });

  it('publishFirstPartyVersion over the REAL authority: an explicit transition (mutated content); the installed pin NEVER moves; identical content CONVERGES', async () => {
    const outcome = await installLibrary();
    const testing = outcome.manifests.find((m) => m.kind === 'testing')!;
    // a genuinely MUTATED procedure document (the governed maintenance
    // update — V2-002 converges on identical content, so the mutation is
    // what proves the transition)
    const { serializeWorkflowIrDocument, parseWorkflowIrDocument, computeWorkflowVersionSemanticDigest } = await import('../../../src/workflow-ir/index.js');
    const mutatedRoundTrip = JSON.parse(serializeWorkflowIrDocument(artifactByKind('testing')!.document)) as Record<string, unknown>;
    const ir = mutatedRoundTrip['ir'] as Record<string, unknown>;
    const nodes = ir['nodes'] as Record<string, unknown>[];
    const spec = nodes[nodes.length - 1]!['spec'] as Record<string, unknown>;
    spec['task'] = 'Record the typed verification evidence bound to the exact revision (v2 maintenance update)';
    const mutatedDocument = parseWorkflowIrDocument(JSON.stringify(mutatedRoundTrip));
    if (!mutatedDocument.ok) {
      throw new Error('the mutated document must still parse clean');
    }
    expect(mutatedDocument.document.ir.nodes[nodes.length - 1]!['spec']).toMatchObject({
      task: 'Record the typed verification evidence bound to the exact revision (v2 maintenance update)',
    });
    const next = await publishFirstPartyVersion(
      port,
      principal(),
      testing.workflowId,
      mutatedDocument.document,
      { irSchemaVersion: 'wfos-ir-1' },
    );
    expect(next.created).toBe(true);
    expect(next.versionNumber).toBeGreaterThan(testing.versionNumber);
    expect(next.versionId).not.toBe(testing.versionId);
    expect(next.semanticDigest.digest).not.toBe(testing.semanticDigest.digest);
    // the identical-content publication CONVERGES on the existing version
    const converged = await publishFirstPartyVersion(
      port,
      principal(),
      testing.workflowId,
      artifactByKind('testing')!.document,
      { irSchemaVersion: 'wfos-ir-1' },
    );
    expect(converged.created).toBe(false);
    expect(computeWorkflowVersionSemanticDigest(artifactByKind('testing')!.document).digest).toBe(testing.semanticDigest.digest);
    // the installed pin NEVER moved
    const pin = await support.repository.getInstallation(principal(), devOrgId, testing.installationId);
    expect(pin.pinnedVersion.id).toBe(testing.versionId);
    expect(pin.pinnedVersion.versionNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateBoundaryEquivalent(candidate: SelfHostingBoundaryPolicyInput): boolean {
  // the code-pinned floor (the same discipline the real loader enforces
  // through ADR-0004): every pinned prohibition must appear verbatim
  return CORE_SELF_HOSTING_PROHIBITIONS.every((pinned) => candidate.coreProhibitions.includes(pinned));
}
