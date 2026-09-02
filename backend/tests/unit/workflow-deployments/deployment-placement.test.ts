/**
 * V2-009 — execution placement resolution (PURE parts): the deployment
 * placement policy ↔ compiled-plan compatibility check (V2-007 consumed —
 * the real compiler compiles the real IR), and the V2-004 requirement-set
 * projection (locality/trust/privacy — the capability dimension stays with
 * per-step routing, constitution §5/§12).
 *
 * REQUIRED REGRESSION coverage: "placement failure" (the compatibility
 * rejection + the resolution-no-eligible-node typed failure are the two
 * placement failure modes; the latter is exercised in the integration
 * battery on the real matcher).
 */
import { describe, it, expect } from 'vitest';
import {
  checkPlacementCompatibility,
  deploymentRequirementSetOf,
  effectiveDeploymentLocationClasses,
} from '../../../src/workflow-deployments/internal/placement.js';
import { createWorkflowIrBuilder, serializeWorkflowIrDocument, type WorkflowNode } from '../../../src/workflow-ir/index.js';
import { compileWorkflow } from '../../../src/workflow-compiler/index.js';

function node(id: string, placement: WorkflowNode['placement']): WorkflowNode {
  return {
    id,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement,
    inputs: [],
    outputs: [{ name: 'out', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
}

function planOf(placement: WorkflowNode['placement']) {
  const doc = createWorkflowIrBuilder()
    .withStart('step_one')
    .addWorkflowInput({ name: 'in', type: { kind: 'string' } })
    .addNode(node('step_one', placement))
    .build();
  const compiled = compileWorkflow(JSON.parse(serializeWorkflowIrDocument(doc)));
  if (!compiled.ok) throw new Error(`fixture plan failed to compile: ${compiled.diagnostics[0]?.message}`);
  return compiled.artifact.plan;
}

describe('V2-009 — deployment location classes (constitution §12 semantics)', () => {
  it('hard locality ids resolve to their single class; soft ids to both', () => {
    expect(effectiveDeploymentLocationClasses({ placement: { required: 'device_local' }, privacy: { localOnly: false } })).toEqual(
      ['device'],
    );
    expect(effectiveDeploymentLocationClasses({ placement: { required: 'cloud_required' }, privacy: { localOnly: false } })).toEqual(
      ['cloud'],
    );
    expect(
      effectiveDeploymentLocationClasses({ placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } }),
    ).toEqual(['device', 'cloud']);
  });

  it('an explicit fallback chain widens the allowed classes (never silently)', () => {
    expect(
      effectiveDeploymentLocationClasses({
        placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
        privacy: { localOnly: false },
      }),
    ).toEqual(['device', 'cloud']);
    // device_preferred WITHOUT cloud fallback stays device-only
    expect(effectiveDeploymentLocationClasses({ placement: { required: 'device_preferred' }, privacy: { localOnly: false } })).toEqual(
      ['device'],
    );
  });

  it('privacy localOnly intersects the chain with {device} (constitution §12/§16)', () => {
    expect(
      effectiveDeploymentLocationClasses({
        placement: { required: 'cloud_allowed' },
        privacy: { localOnly: true },
      }),
    ).toEqual(['device']);
    // a localOnly deployment that requires cloud is structurally empty (and
    // therefore also incompatible with ANY plan — pinned below)
    expect(
      effectiveDeploymentLocationClasses({ placement: { required: 'cloud_required' }, privacy: { localOnly: true } }),
    ).toEqual([]);
  });
});

describe('V2-009 — deployment ↔ compiled-plan placement compatibility (V2-007 consumed)', () => {
  const base = { privacy: { localOnly: false } };

  it('ACCEPTS a compatible plan (cloud_allowed deployment over a cloud_preferred step)', () => {
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'cloud_allowed' } },
      plan: planOf('cloud_preferred'),
    });
    expect(result.ok).toBe(true);
  });

  it('ACCEPTS device placement over device steps and mixed regions over mixed steps', () => {
    expect(
      checkPlacementCompatibility({
        policy: { ...base, placement: { required: 'device_local' } },
        plan: planOf('device_preferred'),
      }).ok,
    ).toBe(true);
    expect(
      checkPlacementCompatibility({
        policy: { ...base, placement: { required: 'any_supported_node' } },
        plan: planOf('device_local'),
      }).ok,
    ).toBe(true);
  });

  it('REJECTS a device_local deployment over a cloud_required step (typed DEPLOYMENT_PLAN_INCOMPATIBLE, locality is correctness)', () => {
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'device_local' } },
      plan: planOf('cloud_required'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DEPLOYMENT_PLAN_INCOMPATIBLE');
      expect(result.detail).toContain('cloud_required');
      expect(result.detail).toContain('device_local');
    }
  });

  it('REJECTS a cloud_required deployment over a device_local step', () => {
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'cloud_required' } },
      plan: planOf('device_local'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DEPLOYMENT_PLAN_INCOMPATIBLE');
  });

  it('REJECTS privacy localOnly over a cloud_required step (the privacy constraint is not a hint)', () => {
    const result = checkPlacementCompatibility({
      policy: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: true } },
      plan: planOf('cloud_required'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DEPLOYMENT_PLAN_INCOMPATIBLE');
      expect(result.detail).toContain('localOnly');
    }
  });

  it('REJECTS device_preferred WITHOUT cloud fallback over a cloud_required step (no silent region escape)', () => {
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'device_preferred' } },
      plan: planOf('cloud_required'),
    });
    expect(result.ok).toBe(false);
  });

  it('ACCEPTS device_preferred WITH an explicit cloud fallback over a cloud_required step (the fallback is explicit)', () => {
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] } },
      plan: planOf('cloud_required'),
    });
    expect(result.ok).toBe(true);
  });

  it('an empty region (localOnly + cloud_required chain) is rejected for ANY plan (typed)', () => {
    const result = checkPlacementCompatibility({
      policy: { placement: { required: 'cloud_required' }, privacy: { localOnly: true } },
      plan: planOf('cloud_allowed'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DEPLOYMENT_PLAN_INCOMPATIBLE');
  });

  it('EVERY unit is checked (one incompatible step anywhere rejects the deployment)', () => {
    const doc = createWorkflowIrBuilder()
      .withStart('a')
      .addWorkflowInput({ name: 'in', type: { kind: 'string' } })
      .addNode(node('a', 'device_local'))
      .addNode(node('b', 'cloud_required'))
      .addEdge({ from: 'a', to: 'b', on: 'success' })
      .build();
    const compiled = compileWorkflow(JSON.parse(serializeWorkflowIrDocument(doc)));
    if (!compiled.ok) throw new Error('fixture plan failed to compile');
    const result = checkPlacementCompatibility({
      policy: { ...base, placement: { required: 'device_local' } },
      plan: compiled.artifact.plan,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('cloud_required');
  });
});

describe('V2-009 — the V2-004 requirement-set projection (the matcher contract)', () => {
  it('projects the deployment policy into a capability-free requirement set (locality/trust/privacy only)', () => {
    const set = deploymentRequirementSetOf({
      placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
      privacy: { localOnly: false },
      minTrustTier: 'trusted',
    });
    expect(set.capabilities).toEqual([]);
    expect(set.placement).toEqual({ required: 'device_preferred', fallbackOrder: ['cloud_allowed'] });
    expect(set.privacy).toEqual({ localOnly: false });
    expect(set.minTrustTier).toBe('trusted');
  });

  it('defaults: no trust tier, no human-approval requirement, degraded health floor', () => {
    const set = deploymentRequirementSetOf({
      placement: { required: 'cloud_allowed' },
      privacy: { localOnly: false },
    });
    expect(set.minTrustTier).toBeUndefined();
    expect(set.humanApprovalRequired).toBeUndefined();
    expect(set.minNodeHealth).toBeUndefined();
  });
});

describe('V2-009 — the placement policy validation (fail-closed at the service boundary)', () => {
  it('is exercised through the service (integration battery); the pure projection above never minted a registry id', () => {
    // The pure projection consumes V2-004's PlacementId/PrivacyConstraint
    // verbatim; no new identifier shape is introduced here (pinned by the
    // registry-vocabulary battery).
    const set = deploymentRequirementSetOf({ placement: { required: 'any_supported_node' }, privacy: { localOnly: false } });
    expect(['device_local', 'device_preferred', 'cloud_allowed', 'cloud_preferred', 'cloud_required', 'any_supported_node']).toContain(
      set.placement.required,
    );
    expect(() => {
      const bad = { placement: { required: 'somewhere_else' } } as never;
      deploymentRequirementSetOf(bad);
    }).toThrow();
  });
});
