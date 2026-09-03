import { describe, it, expect } from 'vitest';
import {
  planFailedWorkflowRecovery,
  publishFirstPartyVersion,
  artifactByKind,
  type FailedRunFacts,
  type FailedWorkflowRecoveryPlan,
  type FirstPartyPinFacts,
  type FirstPartyTargetVersionFacts,
  type FirstPartyInstallPort,
  type PlanFailedWorkflowRecoveryInput,
} from '../../../src/self-hosted-library/index.js';
import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../../src/architecture-checkpoints/index.js';
import { createWorkflowIrBuilder } from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import { makeDevEnvironment, DEV_RUN_ID, DEV_PRINCIPAL, DEV_PROTOCOL, DEV_TENANT } from './helpers.js';

/**
 * V2-013 Task 6 — the failed-workflow recovery battery.
 *
 * Proves (the frozen regression "failed-workflow recovery"):
 *   - a terminally FAILED first-party run → retry_same_pin: a NEW run
 *     against the SAME pinned version (the failed run is never
 *     resurrected; the plan carries the pin identity);
 *   - an IN-PROGRESS run is NOT recoverable (typed block — a run is
 *     never interrupted or resurrected by the plan);
 *   - a run of a DIFFERENT workflow/version → typed scope mismatch;
 *   - retry with a DRIFTED installation pin → blocked (the pin never
 *     moves silently; an explicit advance is required);
 *   - advance_version → an EXPLICIT governed transition (to a DIFFERENT
 *     version of the SAME workflow; the failed run stays failed);
 *   - an advance to the manifest's OWN version → typed invalid;
 *   - a weakened boundary model at recovery time → blocked (governance
 *     preserved at every recovery decision).
 */

function realBoundary() {
  return {
    may: ['plan its own implementation'],
    mayNot: [...CORE_SELF_HOSTING_PROHIBITIONS],
    coreProhibitions: [...CORE_SELF_HOSTING_PROHIBITIONS],
  };
}

function failedRun(overrides: Partial<FailedRunFacts> = {}): FailedRunFacts {
  return {
    runId: `${DEV_RUN_ID}-failed`,
    workflowId: 'PLACEHOLDER',
    versionId: 'PLACEHOLDER',
    state: 'failed',
    ...overrides,
  };
}

function input(
  manifest: PlanFailedWorkflowRecoveryInput['manifest'],
  run: FailedRunFacts,
  pinFacts: FirstPartyPinFacts,
  request: PlanFailedWorkflowRecoveryInput['request'],
  boundary = realBoundary(),
): PlanFailedWorkflowRecoveryInput {
  return {
    manifest,
    failedRun: run,
    pinFacts,
    boundary,
    artifact: artifactByKind('dogfooding')!,
    request,
  };
}

/** The mutated dogfooding document (a genuinely NEW version — a changed task). */
function mutatedDogfoodingDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('install_workflow')
    .addWorkflowInput({ name: 'procedureKind', type: { kind: 'string' } })
    .addNode({
      id: 'install_workflow',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'workflow.execute' },
      capabilityRequirements: ['workflow.execute'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'execute_workflow',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Execute the installed workflow end-to-end through the real execution authorities (MUTATED for the advance-target fixture)' },
      capabilityRequirements: ['workflow.execute', 'filesystem.read'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'record_evidence',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Record the dogfooding evidence and corrective observations' },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'done', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addEdge({ from: 'install_workflow', to: 'execute_workflow', on: 'success' })
    .addEdge({ from: 'execute_workflow', to: 'record_evidence', on: 'success' })
    .build();
}

describe('V2-013 failed-workflow recovery — typed plans', () => {
  it('a terminally FAILED run → retry_same_pin (a NEW run against the SAME pin; never in-place resurrection)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'retry_same_pin');
    if (plan.kind === 'retry_same_pin') {
      expect(plan.workflowId).toBe(manifest.workflowId);
      expect(plan.versionId).toBe(manifest.versionId);
      expect(plan.installationId).toBe(manifest.installationId);
      expect(plan.failedRunId).toBe(`${DEV_RUN_ID}-failed`);
    }
  });

  it('an IN-PROGRESS run is NOT recoverable (typed block)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId, state: 'running' }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RUN_NOT_FAILED');
    }
  });

  it('a run of a DIFFERENT version → typed scope mismatch (a retry never targets a foreign run)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: 'wfwv-foreign' }), pinFacts, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RUN_SCOPE_MISMATCH');
    }
  });

  it('retry with a DRIFTED installation pin → blocked (the pin never moves silently)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const drifted: FirstPartyPinFacts = { ...pinFacts, versionId: 'wfwv-moved', versionNumber: 2, contentDigest: 'digest-moved' };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), drifted, { action: 'retry_same_pin' }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_ADVANCE_INVALID');
    }
  });

  it('advance_version → an EXPLICIT governed transition to a REAL PUBLISHED AND INSTALLED target version of the SAME workflow (both facts read back from the authority)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    // a REAL new version published through the module's own explicit
    // transition (create-or-converge over the V2-002-shaped port)
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    expect(published.created).toBe(true);
    expect(published.versionNumber).toBe(2);
    // the target must be INSTALLED through the port's real install path and
    // READ BACK (a DISTINCT installation record pinning v2 — V2-002 derives
    // the installation identity from (organizationId, versionId): the
    // current installation is never re-pinned)
    const targetInstallation = await installTargetPinFacts(port, manifest.workflowId, published.versionId);
    expect(targetInstallation.installationId).not.toBe(manifest.installationId);
    expect(targetInstallation.versionId).toBe(published.versionId);
    // the authoritative target facts: BOTH the version record AND the
    // installation read-back
    const targetVersion: FirstPartyTargetVersionFacts = {
      version: {
        id: published.versionId,
        workflowId: manifest.workflowId,
        versionNumber: published.versionNumber,
        contentDigest: published.contentDigest,
      },
      installation: targetInstallation,
    };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion,
      }),
    );
    expectPlan(plan, 'advance_version');
    if (plan.kind === 'advance_version') {
      expect(plan.workflowId).toBe(manifest.workflowId);
      expect(plan.fromVersionId).toBe(manifest.versionId);
      expect(plan.toVersionId).toBe(published.versionId);
      expect(plan.failedRunId).toBe(`${DEV_RUN_ID}-failed`);
    }
  });

  it('an advance to the manifest OWN version → typed invalid (not a transition — even with the manifest\'s own version and installation facts supplied)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: manifest.versionId,
        // even well-formed facts (the manifest's own version AND its own
        // installation read-back) are not a transition: the same-version
        // check fires first (the advance must target a DIFFERENT version,
        // proven or not)
        targetVersion: {
          version: {
            id: manifest.versionId,
            workflowId: manifest.workflowId,
            versionNumber: manifest.versionNumber,
            contentDigest: manifest.contentDigest,
          },
          installation: pinFacts,
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_ADVANCE_INVALID');
    }
  });

  it('a WEAKENED boundary model at recovery time → blocked (governance preserved at every recovery decision)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const weakened = {
      may: ['plan its own implementation'],
      mayNot: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
      coreProhibitions: CORE_SELF_HOSTING_PROHIBITIONS.slice(0, 7),
    };
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, { action: 'retry_same_pin' }, weakened),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_BOUNDARY_DENIED');
    }
  });
});

// =============================================================================
// The PR #160 Blocker-2 correction — the advance target is PROVEN by
// authoritative version facts.
//
// The architect's finding: `planFailedWorkflowRecovery()` accepted ANY
// `toVersionId` different from the current version without proving the
// target exists, belongs to the same workflow, or is an authoritative
// published version — and the previous test explicitly accepted a
// SYNTHETIC target, making the hole contractual, not hypothetical.
// =============================================================================

describe('V2-013 failed-workflow recovery — the advance target is proven by authoritative version facts (PR #160 Blocker-2)', () => {
  it('a SYNTHETIC target (no authority facts at all) → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (fail-closed; a synthetic target is never an advance)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts,
        // the old hole's exact shape: a bare toVersionId that exists nowhere
        // (intentionally malformed — the runtime must reject it typed)
        { action: 'advance_version', toVersionId: 'wfwv-synthetic-target' } as unknown as PlanFailedWorkflowRecoveryInput['request'],
      ),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('wfwv-synthetic-target');
    }
  });

  it('MALFORMED target facts (missing identity fields) → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (fail-closed on the shape)', async () => {
    const { manifests, pinFacts } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: 'wfwv-malformed-target',
        targetVersion: { version: { workflowId: manifest.workflowId } } as unknown as FirstPartyTargetVersionFacts,
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
    }
  });

  it('facts proving a DIFFERENT version than the requested target → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (the facts must bind the exact target)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        // requests a version the facts do NOT prove (the version leg fires
        // before the installation leg is ever consulted)
        toVersionId: 'wfwv-some-other-version',
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
        } as unknown as FirstPartyTargetVersionFacts,
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('wfwv-some-other-version');
    }
  });

  it('facts of a FOREIGN workflow → SELF_HOSTING_RECOVERY_TARGET_UNPROVEN (an advance never crosses workflows)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    // a REAL version of a DIFFERENT first-party workflow (the testing kind)
    const testingManifest = manifests.find((m) => m.kind === 'testing')!;
    const foreignPublished = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      testingManifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: foreignPublished.versionId,
        // (the version leg fires on the foreign workflow before the
        // installation leg is ever consulted)
        targetVersion: {
          version: {
            id: foreignPublished.versionId,
            workflowId: testingManifest.workflowId,
            versionNumber: foreignPublished.versionNumber,
            contentDigest: foreignPublished.contentDigest,
          },
        } as unknown as FirstPartyTargetVersionFacts,
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_UNPROVEN');
      expect(plan.failure.detail).toContain('SAME workflow');
    }
  });
});

// =============================================================================
// The PR #160 RESIDUAL Blocker-2 correction — the advance target is proven
// INSTALLED in the SAME development environment.
//
// The architect's finding (review 5102958519): the corrected recovery
// accepted an authoritative V2-002 version record WITHOUT the target
// version being installed through V2-002 in the development environment —
// publication alone made a target transition-ready. The correction: the
// advance proof requires BOTH the authoritative version facts AND an
// authoritative installation read-back showing the exact target pin in
// the same development environment (the same tenant, the exact pinned
// (workflowId, versionId, versionNumber, contentDigest)).
// =============================================================================

describe('V2-013 failed-workflow recovery — the advance target is proven INSTALLED in the same development environment (PR #160 residual Blocker-2)', () => {
  it('PUBLISHED but NOT INSTALLED → SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED (the residual hole\'s exact shape: well-formed version facts, no installation read-back)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    // a REAL published version — the version facts are genuine and
    // well-formed (the version EXISTS and is published) ...
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        // ... but NO installation read-back is supplied: the target was
        // never installed through V2-002 in this environment — publication
        // alone is NOT transition-readiness (the residual hole)
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
        } as unknown as FirstPartyTargetVersionFacts,
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(plan.failure.detail).toContain(published.versionId);
      expect(plan.failure.detail).toContain('NOT-installed');
    }
  });

  it('MALFORMED installation facts (missing pin fields) → SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED (fail-closed on the shape)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
          installation: { organizationId: DEV_TENANT } as unknown as FirstPartyTargetVersionFacts['installation'],
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
    }
  });

  it('an installation of a FOREIGN environment (organizationId mismatch) → SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED (the same development environment only)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    // the target IS installed — but in a DIFFERENT tenant (an installation
    // read-back of another environment is not this environment's pin)
    const foreignTenant = 'org-foreign-environment';
    const foreignInstall = await port.installVersion(DEV_PRINCIPAL, {
      organizationId: foreignTenant,
      workflowId: manifest.workflowId,
      versionId: published.versionId,
    });
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
          installation: {
            organizationId: foreignTenant,
            installationId: foreignInstall.installation.id,
            workflowId: manifest.workflowId,
            versionId: published.versionId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(plan.failure.detail).toContain(foreignTenant);
    }
  });

  it('an installation pinning the WRONG version (the manifest\'s own v1 pin presented as the target installation) → SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
          // the CURRENT installation (pinning v1) presented as the target
          // installation — a real installation, but NOT of the target pin
          installation: pinFacts,
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(plan.failure.detail).toContain('EXACT');
    }
  });

  it('a TAMPERED installation pin (a real target installation with a mutated contentDigest) → SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED (the facts must cross-validate)', async () => {
    const { manifests, pinFacts, port } = await fixture();
    const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
    const published = await publishFirstPartyVersion(
      port,
      DEV_PRINCIPAL,
      manifest.workflowId,
      mutatedDogfoodingDocument(),
      DEV_PROTOCOL,
    );
    const targetInstallation = await installTargetPinFacts(port, manifest.workflowId, published.versionId);
    const plan = planFailedWorkflowRecovery(
      input(manifest, failedRun({ workflowId: manifest.workflowId, versionId: manifest.versionId }), pinFacts, {
        action: 'advance_version',
        toVersionId: published.versionId,
        targetVersion: {
          version: {
            id: published.versionId,
            workflowId: manifest.workflowId,
            versionNumber: published.versionNumber,
            contentDigest: published.contentDigest,
          },
          // single-dimension tamper: a real read-back with the digest mutated
          installation: { ...targetInstallation, contentDigest: 'digest-tampered' },
        },
      }),
    );
    expectPlan(plan, 'blocked');
    if (plan.kind === 'blocked') {
      expect(plan.failure.code).toBe('SELF_HOSTING_RECOVERY_TARGET_NOT_INSTALLED');
      expect(plan.failure.detail).toContain('digest-tampered');
    }
  });
});

function expectPlan(plan: FailedWorkflowRecoveryPlan, kind: 'retry_same_pin' | 'advance_version' | 'blocked') {
  if (plan.kind !== kind) {
    throw new Error(`expected plan kind ${kind}, got ${plan.kind}${plan.kind === 'blocked' ? ` (${plan.failure.code}: ${plan.failure.detail})` : ''}`);
  }
}

async function fixture(): Promise<{ manifests: Awaited<ReturnType<typeof makeDevEnvironment>>['manifests']; pinFacts: FirstPartyPinFacts; port: FirstPartyInstallPort }> {
  const { port, manifests } = await makeDevEnvironment();
  const manifest = manifests.find((m) => m.kind === 'dogfooding')!;
  return {
    port,
    manifests,
    pinFacts: {
      organizationId: DEV_TENANT,
      installationId: manifest.installationId,
      workflowId: manifest.workflowId,
      versionId: manifest.versionId,
      versionNumber: manifest.versionNumber,
      contentDigest: manifest.contentDigest,
    },
  };
}

/**
 * Install the published target through the port's real install path and
 * READ BACK its pin facts (the authoritative installation read-back — a
 * DISTINCT installation record pinning the target version; V2-002 derives
 * the installation identity from (organizationId, versionId)).
 */
async function installTargetPinFacts(
  port: FirstPartyInstallPort,
  workflowId: string,
  versionId: string,
): Promise<FirstPartyPinFacts> {
  const installed = await port.installVersion(DEV_PRINCIPAL, {
    organizationId: DEV_TENANT,
    workflowId,
    versionId,
  });
  const detail = await port.getInstallation(DEV_PRINCIPAL, DEV_TENANT, installed.installation.id);
  return {
    organizationId: DEV_TENANT,
    installationId: installed.installation.id,
    workflowId: detail.pinnedVersion.workflowId,
    versionId: detail.pinnedVersion.id,
    versionNumber: detail.pinnedVersion.versionNumber,
    contentDigest: detail.pinnedVersion.contentDigest,
  };
}
