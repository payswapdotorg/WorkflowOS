/**
 * WORK-045 — unit tests for the agent-role catalog + resolution.
 *
 * Pure unit tests (no database, no I/O) of the closed static catalog. They
 * prove:
 *
 *   - W045-AC01 — the provider-independent role contract: every role carries
 *     identity, display name, purpose, responsibilities, declarative
 *     capabilities/constraints, expected inputs/outputs, and lifecycle
 *     metadata — with NO provider/model identifiers anywhere;
 *   - W045-AC02 — the closed initial catalog: all eight required identities
 *     exist exactly once;
 *   - W045-AC03 — deterministic resolution: repeated resolution returns the
 *     identical result, independent of call/iteration order;
 *   - W045-AC04 — no provider binding: no provider/model token in any
 *     content string;
 *   - W045-AC05 — capability requirements are declarative (the WORK-043
 *     vocabulary; never evaluated here);
 *   - W045-AC06 — native/external neutrality: every role declares the
 *     symmetric ['native', 'external'] advisory mode set and no
 *     mode-selecting capability;
 *   - W045-AC10 — stable versioning: the revision is a deterministic
 *     content-derived digest; changing a definition changes the revision;
 *     the catalog is deep-frozen (no silent mutation);
 *   - W045-AC13 — the explainable resolution output (purpose,
 *     responsibilities, requirements, version, advisory-vs-authoritative
 *     semantics);
 *   - W045-AC14 — the EMPTY forward-compatibility extension seam;
 *   - fail-closed catalog validation (an invalid definition can never load).
 */
import { describe, it, expect } from 'vitest';
import {
  DefaultAgentRoleCatalogService,
  AGENT_ROLE_CATALOG,
  AGENT_ROLE_CATALOG_ORDER,
  AGENT_ROLE_IDENTITIES,
  AGENT_ROLE_DECLARATION_SEMANTICS,
  buildAgentRoleCatalog,
  canonicalRoleContent,
  computeRoleRevision,
  validateAgentRoleDefinition,
  type AgentRoleContract,
  type AgentRoleDefinition,
  type AgentRoleResolution,
} from '../../../src/agent-roles/index.js';
import type { CapabilityRequirement } from '../../../src/execution-policy/index.js';

const REQUIRED_IDENTITIES: readonly string[] = [
  'architect',
  'planner',
  'implementer',
  'tester',
  'security-reviewer',
  'performance-reviewer',
  'ux-reviewer',
  'release-engineer',
];

const CAPABILITY_VOCABULARY: readonly CapabilityRequirement[] = [
  'coding_agent',
  'browser',
  'repository_access',
  'terminal',
  'private_network',
  'native_api',
  'external_ui',
];

const PROVIDER_TOKEN =
  /\b(claude|qwen|gpt|o1|o3|openai|anthropic|gemini|copilot|cursor|codex|aider|windsurf|sonnet|opus|haiku|llama|mistral|deepseek)\b/i;

function freshService(): DefaultAgentRoleCatalogService {
  return new DefaultAgentRoleCatalogService();
}

function contentStrings(role: AgentRoleContract): string[] {
  const out: string[] = [role.displayName, role.purpose, ...role.responsibilities];
  for (const c of role.advisoryConstraints) out.push(c.kind, c.description);
  for (const list of [role.expectedInputs, role.expectedOutputs] as const) {
    for (const a of list) out.push(a.name, a.description);
  }
  return out;
}

// ============================================================================
// W045-AC02 — the closed initial catalog
// ============================================================================

describe('WORK-045 — the closed initial catalog (W045-AC02)', () => {
  it('contains ALL EIGHT required role identities, each EXACTLY once', () => {
    const identities = AGENT_ROLE_CATALOG.map((r) => r.identity);
    expect(identities.sort()).toEqual([...REQUIRED_IDENTITIES].sort());
    expect(new Set(identities).size).toBe(8);
    expect(AGENT_ROLE_CATALOG).toHaveLength(8);
  });

  it('the declared order is the deterministic catalog order (the list never derives from object iteration)', () => {
    expect(AGENT_ROLE_CATALOG_ORDER).toEqual(REQUIRED_IDENTITIES);
    expect(AGENT_ROLE_IDENTITIES).toEqual(REQUIRED_IDENTITIES);
    const service = freshService();
    expect(service.listRoles().map((r) => r.role.identity)).toEqual(REQUIRED_IDENTITIES);
  });

  it('buildAgentRoleCatalog returns a fresh equivalently-ordered catalog (idempotent construction)', () => {
    const rebuilt = buildAgentRoleCatalog();
    expect(rebuilt.map((r) => r.identity)).toEqual(AGENT_ROLE_CATALOG.map((r) => r.identity));
    expect(rebuilt.map((r) => r.lifecycle.revision)).toEqual(
      AGENT_ROLE_CATALOG.map((r) => r.lifecycle.revision),
    );
  });
});

// ============================================================================
// W045-AC01 — the provider-independent role contract
// ============================================================================

describe('WORK-045 — the role contract shape (W045-AC01)', () => {
  it('every role carries the FULL contract: identity, displayName, purpose, responsibilities, requirements, inputs, outputs, lifecycle', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      expect(REQUIRED_IDENTITIES).toContain(role.identity);
      expect(role.displayName.trim().length).toBeGreaterThan(0);
      expect(role.purpose.trim().length).toBeGreaterThan(0);
      expect(role.responsibilities.length).toBeGreaterThanOrEqual(3);
      for (const r of role.responsibilities) expect(r.trim().length).toBeGreaterThan(0);
      expect(role.requiredCapabilities.length).toBeGreaterThanOrEqual(1);
      expect(role.expectedInputs.length).toBeGreaterThanOrEqual(2);
      expect(role.expectedOutputs.length).toBeGreaterThanOrEqual(2);
      for (const a of [...role.expectedInputs, ...role.expectedOutputs]) {
        expect(a.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
        expect(a.description.trim().length).toBeGreaterThan(0);
        expect(typeof a.required).toBe('boolean');
      }
      expect(role.lifecycle.contractVersion).toBe(1);
      expect(role.lifecycle.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(role.lifecycle.status).toBe('stable');
    }
  });

  it('every advisory constraint is typed with a non-empty description', () => {
    const kinds = new Set([
      'architecture-sensitive',
      'security-sensitive',
      'human-intervention-permitted',
      'human-intervention-discouraged',
    ]);
    for (const role of AGENT_ROLE_CATALOG) {
      for (const c of role.advisoryConstraints) {
        expect(kinds.has(c.kind)).toBe(true);
        expect(c.description.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================
// W045-AC04 — no provider binding
// ============================================================================

describe('WORK-045 — provider independence (W045-AC04)', () => {
  it('NO provider/model token appears in ANY role content string', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      for (const text of contentStrings(role)) {
        expect(PROVIDER_TOKEN.test(text), `provider token found in '${text}' (${role.identity})`).toBe(false);
      }
    }
  });

  it('no role names a provider, model, adapter, or SDK in its structural fields', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      expect(role, `${role.identity} carries no provider field`).not.toHaveProperty('provider');
      expect(role, `${role.identity} carries no model field`).not.toHaveProperty('model');
      expect(role, `${role.identity} carries no adapter field`).not.toHaveProperty('adapter');
    }
  });
});

// ============================================================================
// W045-AC05 — declarative capability requirements
// ============================================================================

describe('WORK-045 — declarative capability requirements (W045-AC05)', () => {
  it('every required capability uses the WORK-043 vocabulary (consumed by the EXISTING boundary — never re-invented)', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      for (const cap of role.requiredCapabilities) {
        expect(CAPABILITY_VOCABULARY, `${role.identity}: '${cap}' must be WORK-043 vocabulary`).toContain(cap);
      }
      expect(new Set(role.requiredCapabilities).size).toBe(role.requiredCapabilities.length);
    }
  });

  it('the declaration semantics mark capabilities as declarative-requirement evaluated by execution-policy (WORK-043) — never here', () => {
    for (const resolution of freshService().listRoles()) {
      expect(resolution.declarationSemantics.requiredCapabilities).toBe('declarative-requirement');
      expect(resolution.declarationSemantics.requiredCapabilitiesEvaluatedBy).toBe(
        'execution-policy (WORK-043) at execution time',
      );
    }
  });
});

// ============================================================================
// W045-AC06 — native/external neutrality
// ============================================================================

describe('WORK-045 — native/external neutrality (W045-AC06)', () => {
  it('every role declares the SYMMETRIC advisory mode set [native, external] — no intrinsic preference', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      expect(role.execution.supportedModes).toEqual(['native', 'external']);
      expect(role.execution.semantics).toBe('advisory');
    }
  });

  it('NO role requires a mode-SELECTING capability (native_api / external_ui)', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      for (const cap of role.requiredCapabilities) {
        expect(cap, `${role.identity}: mode-selecting capabilities are forbidden`).not.toBe('native_api');
        expect(cap, `${role.identity}: mode-selecting capabilities are forbidden`).not.toBe('external_ui');
      }
    }
  });

  it('the same role contract serves BOTH modes: no mode field exists on the contract at all', () => {
    // The contract is mode-blind by construction — the execution declaration
    // is advisory metadata, never a dispatch or selection input.
    for (const role of AGENT_ROLE_CATALOG) {
      expect(role, `${role.identity}: no preferredMode field`).not.toHaveProperty('preferredMode');
      expect(role, `${role.identity}: no provider field`).not.toHaveProperty('provider');
    }
  });
});

// ============================================================================
// W045-AC03 — deterministic resolution
// ============================================================================

describe('WORK-045 — deterministic resolution (W045-AC03)', () => {
  it('repeated resolution returns the IDENTICAL frozen object (=== stable)', () => {
    const service = freshService();
    const first = service.resolveRole('implementer');
    for (let i = 0; i < 10; i += 1) {
      expect(service.resolveRole('implementer')).toBe(first);
    }
  });

  it('resolution is independent of call order (resolve in reverse — same objects)', () => {
    const forward = freshService();
    const reverse = freshService();
    const reversedIds = [...REQUIRED_IDENTITIES].reverse();
    for (const id of reversedIds) {
      const r = reverse.resolveRole(id);
      expect(r).not.toBeNull();
      expect(r!.role).toBe(forward.resolveRole(id)!.role);
    }
  });

  it('listRoles returns the declared order on EVERY call (never object-iteration order)', () => {
    const service = freshService();
    const first = service.listRoles().map((r) => r.role.identity);
    for (let i = 0; i < 5; i += 1) {
      expect(service.listRoles().map((r) => r.role.identity)).toEqual(first);
      expect(first).toEqual(REQUIRED_IDENTITIES);
    }
  });

  it('an UNKNOWN identity resolves to null (no fallback, no nearest-match)', () => {
    const service = freshService();
    expect(service.resolveRole('nonexistent-role')).toBeNull();
    expect(service.resolveRole('')).toBeNull();
    expect(service.resolveRole('IMPLEMENTER')).toBeNull(); // identity is exact
  });

  it('fresh service instances resolve the SAME frozen catalog objects (global immutable truth)', () => {
    const a = freshService().resolveRole('architect');
    const b = new DefaultAgentRoleCatalogService().resolveRole('architect');
    expect(a!.role).toBe(b!.role);
  });
});

// ============================================================================
// W045-AC10 — stable versioning + immutability
// ============================================================================

describe('WORK-045 — stable versioning + immutability (W045-AC10)', () => {
  it('the revision is the DETERMINISTIC content-derived digest (recomputed === stored)', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      const { revision, ...lifecycleRest } = role.lifecycle;
      const recomputed = computeRoleRevision({
        ...role,
        lifecycle: { contractVersion: lifecycleRest.contractVersion, status: lifecycleRest.status },
      } as AgentRoleDefinition);
      expect(recomputed).toBe(revision);
      // The canonical serialization is deterministic (key order sorted).
      expect(canonicalRoleContent({ ...role, lifecycle: { contractVersion: 1, status: 'stable' } } as AgentRoleDefinition))
        .toBe(canonicalRoleContent({ ...role, lifecycle: { contractVersion: 1, status: 'stable' } } as AgentRoleDefinition));
    }
  });

  it('CHANGING a role definition changes the revision (a historical reference can never be silently reinterpreted)', () => {
    const implementer = AGENT_ROLE_CATALOG.find((r) => r.identity === 'implementer')!;
    const original = computeRoleRevision({
      ...implementer,
      lifecycle: { contractVersion: implementer.lifecycle.contractVersion, status: 'stable' },
    } as AgentRoleDefinition);

    // Change ONE responsibility → different revision.
    const editedResponsibility = computeRoleRevision({
      ...implementer,
      responsibilities: [...implementer.responsibilities.slice(0, -1), 'A changed responsibility.'],
      lifecycle: { contractVersion: 1, status: 'stable' },
    } as AgentRoleDefinition);
    expect(editedResponsibility).not.toBe(original);

    // Add ONE capability → different revision.
    const editedCapability = computeRoleRevision({
      ...implementer,
      requiredCapabilities: [...implementer.requiredCapabilities, 'private_network'],
      lifecycle: { contractVersion: 1, status: 'stable' },
    } as AgentRoleDefinition);
    expect(editedCapability).not.toBe(original);

    // Change the contract VERSION → different revision (version is content too).
    const editedVersion = computeRoleRevision({
      ...implementer,
      lifecycle: { contractVersion: 2, status: 'stable' },
    } as AgentRoleDefinition);
    expect(editedVersion).not.toBe(original);

    // Future extension data (WORK-046) → different revision, SAME identity:
    // the extension seam is content (detectable change) without touching
    // the identity model.
    const withExtension = computeRoleRevision({
      ...implementer,
      extensions: { delegation: { example: 'delegation metadata' } as never, intelligence: {} },
      lifecycle: { contractVersion: 1, status: 'stable' },
    } as unknown as AgentRoleDefinition);
    expect(withExtension).not.toBe(original);
  });

  it('the catalog is DEEP-FROZEN — mutation attempts throw and never silently alter a definition', () => {
    const service = freshService();
    const role = service.resolveRole('tester')!.role;
    expect(() => {
      (role as unknown as { purpose: string }).purpose = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      (role.responsibilities as unknown as string[]).push('tampered');
    }).toThrow(TypeError);
    expect(() => {
      (role.lifecycle as unknown as { revision: string }).revision = 'deadbeefdeadbeef';
    }).toThrow(TypeError);
    expect(() => {
      (AGENT_ROLE_CATALOG as unknown as AgentRoleContract[]).push(role);
    }).toThrow(TypeError);
    // The stored definition is unchanged after every attempt.
    expect(service.resolveRole('tester')!.role.purpose).toBe(role.purpose);
    expect(service.resolveRole('tester')!.role.lifecycle.revision).toBe(role.lifecycle.revision);
  });
});

// ============================================================================
// W045-AC13 — the explainable resolution output
// ============================================================================

describe('WORK-045 — the explainable resolution output (W045-AC13)', () => {
  it('every resolution identifies purpose, responsibilities, requirements, version, and the advisory-vs-authoritative semantics', () => {
    const service = freshService();
    for (const resolution of service.listRoles()) {
      const { role, declarationSemantics } = resolution;
      expect(role.purpose.length).toBeGreaterThan(0);
      expect(role.responsibilities.length).toBeGreaterThan(0);
      expect(role.requiredCapabilities.length).toBeGreaterThan(0);
      expect(role.lifecycle.contractVersion).toBe(1);
      expect(role.lifecycle.revision).toMatch(/^[0-9a-f]{16}$/);
      // The advisory-vs-authoritative markers (W045-AC13).
      expect(declarationSemantics.requiredCapabilities).toBe('declarative-requirement');
      expect(declarationSemantics.requiredCapabilitiesEvaluatedBy).toContain('WORK-043');
      expect(declarationSemantics.advisoryConstraints).toBe('advisory');
      expect(declarationSemantics.supportedExecutionModes).toBe('advisory');
      expect(declarationSemantics.dispatchAuthority).toContain('never dispatches');
      expect(declarationSemantics.versioning).toContain('revision');
    }
  });

  it('the semantics block is the shared frozen constant (identical on every resolution)', () => {
    const service = freshService();
    for (const resolution of service.listRoles()) {
      expect(resolution.declarationSemantics).toBe(AGENT_ROLE_DECLARATION_SEMANTICS);
    }
    expect(Object.isFrozen(AGENT_ROLE_DECLARATION_SEMANTICS)).toBe(true);
  });
});

// ============================================================================
// W045-AC14 — the forward-compatibility extension seam
// ============================================================================

describe('WORK-045 — the forward-compatibility extension seam (W045-AC14)', () => {
  it('every role exposes the delegation/intelligence extension point — EMPTY in WORK-045', () => {
    for (const role of AGENT_ROLE_CATALOG) {
      expect(Object.keys(role.extensions.delegation)).toEqual([]);
      expect(Object.keys(role.extensions.intelligence)).toEqual([]);
    }
  });

  it('the identity model is UNCHANGED by extension content: same identity, different revision (computed on an edited copy)', () => {
    const planner = AGENT_ROLE_CATALOG.find((r) => r.identity === 'planner')!;
    const base = computeRoleRevision({
      ...planner,
      lifecycle: { contractVersion: 1, status: 'stable' },
    } as AgentRoleDefinition);
    const extended = computeRoleRevision({
      ...planner,
      extensions: { delegation: { hints: 'future WORK-046 metadata' } as never, intelligence: {} },
      lifecycle: { contractVersion: 1, status: 'stable' },
    } as unknown as AgentRoleDefinition);
    // The identity model does not change — only the content (and thus the
    // revision) does. WORK-046/047 can add data WITHOUT a new identity model.
    expect(extended).not.toBe(base);
  });
});

// ============================================================================
// Fail-closed catalog validation (the closed catalog cannot load an invalid definition)
// ============================================================================

describe('WORK-045 — fail-closed catalog validation', () => {
  function definition(overrides: Partial<AgentRoleDefinition>): AgentRoleDefinition {
    const base = AGENT_ROLE_CATALOG.find((r) => r.identity === 'planner')!;
    return {
      ...base,
      lifecycle: { contractVersion: 1, status: 'stable' },
      ...overrides,
    } as AgentRoleDefinition;
  }

  it('REJECTS a provider token in role content (W045-AC04 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(definition({ purpose: 'Designs with claude and gpt models.' })),
    ).toThrow(/provider\/model tokens are forbidden/);
  });

  it('REJECTS an identity outside the closed catalog (W045-AC02 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(definition({ identity: 'custom-role' as never })),
    ).toThrow(/not one of the eight closed catalog identities/);
  });

  it('REJECTS a mode-selecting capability requirement (W045-AC06 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ requiredCapabilities: ['coding_agent', 'native_api'] as CapabilityRequirement[] }),
      ),
    ).toThrow(/selects an execution mode/);
    expect(() =>
      validateAgentRoleDefinition(
        definition({ requiredCapabilities: ['external_ui'] as CapabilityRequirement[] }),
      ),
    ).toThrow(/selects an execution mode/);
  });

  it('REJECTS an asymmetric mode declaration (W045-AC06 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ execution: { supportedModes: ['native'], semantics: 'advisory' } }),
      ),
    ).toThrow(/symmetric/);
    expect(() =>
      validateAgentRoleDefinition(
        definition({ execution: { supportedModes: ['external', 'native'], semantics: 'advisory' } }),
      ),
    ).toThrow(/symmetric/);
  });

  it('REJECTS non-advisory execution semantics (W045-AC06 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ execution: { supportedModes: ['native', 'external'], semantics: 'authoritative' as never } }),
      ),
    ).toThrow(/advisory/);
  });

  it('REJECTS an out-of-vocabulary capability (W045-AC05 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ requiredCapabilities: ['telepathy'] as never }),
      ),
    ).toThrow(/outside the WORK-043 vocabulary/);
  });

  it('REJECTS incomplete contracts (no responsibilities / no inputs / no outputs)', () => {
    expect(() => validateAgentRoleDefinition(definition({ responsibilities: [] }))).toThrow(/responsibility/);
    expect(() => validateAgentRoleDefinition(definition({ expectedInputs: [] }))).toThrow(/expected input/);
    expect(() => validateAgentRoleDefinition(definition({ expectedOutputs: [] }))).toThrow(/expected output/);
    expect(() => validateAgentRoleDefinition(definition({ purpose: '  ' }))).toThrow(/purpose is required/);
  });

  it('REJECTS non-empty extension data (the seam is reserved for WORK-046/047 — W045-AC14 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ extensions: { delegation: { premature: true } as never, intelligence: {} } }),
      ),
    ).toThrow(/extensions\.delegation must be EMPTY/);
    expect(() =>
      validateAgentRoleDefinition(
        definition({ extensions: { delegation: {}, intelligence: { premature: true } as never } }),
      ),
    ).toThrow(/extensions\.intelligence must be EMPTY/);
  });

  it('REJECTS an untyped advisory-constraint kind (W045-AC05 fail-closed)', () => {
    expect(() =>
      validateAgentRoleDefinition(
        definition({ advisoryConstraints: [{ kind: 'vibes-based' as never, description: 'x' }] }),
      ),
    ).toThrow(/not a typed advisory kind/);
  });
});

// ============================================================================
// W045-AC09 (unit half) — reusable role semantics: the contract is
// provider-agnostic by construction; the integration test proves the same
// contract pairs with different eligible candidates end-to-end.
// ============================================================================

describe('WORK-045 — reusable role semantics (W045-AC09, unit half)', () => {
  it('a resolution carries NO provider/model/mode binding — the same contract serves any eligible executor', () => {
    const service = freshService();
    const a: AgentRoleResolution = service.resolveRole('implementer')!;
    const serialized = JSON.stringify(a.role);
    expect(PROVIDER_TOKEN.test(serialized)).toBe(false);
    expect(serialized).not.toContain('"provider"');
    expect(serialized).not.toContain('"model"');
  });
});
