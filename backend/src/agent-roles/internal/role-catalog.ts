/**
 * WORK-045 — the catalog builder: validation, revision stamping, freezing
 * (internal).
 *
 * Fail-closed by construction: `buildAgentRoleCatalog()` VALIDATES every
 * definition (the Work Order's contract rules), stamps the content-derived
 * revision (W045-AC10), and deep-freezes the result. An invalid definition
 * throws at module load — the closed catalog can never enter the runtime in
 * an unvalidated state.
 *
 * Validation rules (each maps to an acceptance criterion):
 *   - the closed catalog: exactly the eight required identities, each
 *     exactly once, in the declared order (W045-AC02);
 *   - descriptive completeness: non-empty displayName/purpose; ≥ 1
 *     responsibility; ≥ 1 expected input; ≥ 1 expected output (W045-AC01);
 *   - provider independence: no provider/model token in ANY string field
 *     (W045-AC04);
 *   - declarative capabilities: WORK-043 vocabulary ONLY, no duplicates,
 *     and NEVER the mode-selecting kinds 'native_api'/'external_ui'
 *     (W045-AC05/AC06);
 *   - advisory constraints: typed kinds only, no duplicate kinds,
 *     non-empty descriptions (W045-AC05);
 *   - mode neutrality: supportedModes is EXACTLY ['native', 'external']
 *     with advisory semantics (W045-AC06);
 *   - the extension seam is EMPTY (W045-AC14 — WORK-046/047 own its
 *     content);
 *   - artifact names are stable kebab-case identifiers (W045-AC01).
 */
import { createHash } from 'node:crypto';
import type { CapabilityRequirement } from '../../execution-policy/index.js';
import type {
  AgentRoleArtifactDescriptor,
  AgentRoleContract,
  AgentRoleId,
} from '../types.js';
import {
  AGENT_ROLE_CATALOG_ORDER,
  AGENT_ROLE_DEFINITIONS,
  type AgentRoleDefinition,
} from './role-definitions.js';

/** The WORK-043 capability vocabulary (mirrored for validation — single source re-imported). */
const CAPABILITY_VOCABULARY: readonly CapabilityRequirement[] = [
  'coding_agent',
  'browser',
  'repository_access',
  'terminal',
  'private_network',
  'native_api',
  'external_ui',
];

/** The mode-SELECTING capability kinds a role must NEVER require (W045-AC06). */
const MODE_SELECTING_CAPABILITIES: readonly CapabilityRequirement[] = ['native_api', 'external_ui'];

/** Provider/model token pattern (W045-AC04) — none may appear in role content. */
const PROVIDER_TOKEN =
  /\b(claude|qwen|gpt|o1|o3|openai|anthropic|gemini|copilot|cursor|codex|aider|windsurf|sonnet|opus|haiku|llama|mistral|deepseek)\b/i;

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function fail(identity: string, detail: string): never {
  throw new Error(
    `agent-role-catalog-invalid: the definition for '${identity}' failed catalog validation — ${detail} (WORK-045 fail-closed: the closed catalog cannot load an invalid definition)`,
  );
}

// ============================================================================
// VALIDATION (W045-AC01/AC02/AC04/AC05/AC06/AC14)
// ============================================================================

/** Validate one role definition against the WORK-045 contract rules. */
export function validateAgentRoleDefinition(def: AgentRoleDefinition): void {
  const { identity } = def;

  // --- the closed identity model (W045-AC02) -------------------------------
  if (!AGENT_ROLE_CATALOG_ORDER.includes(identity)) {
    fail(identity, `the identity '${identity}' is not one of the eight closed catalog identities`);
  }

  // --- descriptive completeness (W045-AC01) ---------------------------------
  if (typeof def.displayName !== 'string' || def.displayName.trim().length === 0) {
    fail(identity, 'displayName is required');
  }
  if (typeof def.purpose !== 'string' || def.purpose.trim().length === 0) {
    fail(identity, 'purpose is required');
  }
  if (def.responsibilities.length === 0) fail(identity, 'at least one responsibility is required');
  for (const r of def.responsibilities) {
    if (typeof r !== 'string' || r.trim().length === 0) fail(identity, 'every responsibility must be a non-empty string');
  }

  // --- expected inputs / outputs (W045-AC01) ----------------------------------
  if (def.expectedInputs.length === 0) fail(identity, 'at least one expected input is required');
  if (def.expectedOutputs.length === 0) fail(identity, 'at least one expected output is required');
  for (const list of [def.expectedInputs, def.expectedOutputs] as const) {
    for (const a of list) validateArtifact(identity, a);
  }

  // --- provider independence (W045-AC04) ---------------------------------------
  for (const text of allContentStrings(def)) {
    if (PROVIDER_TOKEN.test(text)) {
      fail(identity, `provider/model tokens are forbidden in role content (found in: '${text}')`);
    }
  }

  // --- declarative capabilities (W045-AC05/AC06) --------------------------------
  const seenCaps = new Set<string>();
  for (const cap of def.requiredCapabilities) {
    if (!CAPABILITY_VOCABULARY.includes(cap)) {
      fail(identity, `the capability '${cap}' is outside the WORK-043 vocabulary`);
    }
    if (MODE_SELECTING_CAPABILITIES.includes(cap)) {
      fail(identity, `the capability '${cap}' selects an execution mode — role requirements must stay mode-neutral`);
    }
    if (seenCaps.has(cap)) fail(identity, `the capability '${cap}' is declared twice`);
    seenCaps.add(cap);
  }

  // --- advisory constraints (W045-AC05) -------------------------------------------
  const seenKinds = new Set<string>();
  for (const c of def.advisoryConstraints) {
    const kinds: readonly string[] = [
      'architecture-sensitive',
      'security-sensitive',
      'human-intervention-permitted',
      'human-intervention-discouraged',
    ];
    if (!kinds.includes(c.kind)) fail(identity, `the constraint kind '${c.kind}' is not a typed advisory kind`);
    if (seenKinds.has(c.kind)) fail(identity, `the constraint kind '${c.kind}' is declared twice`);
    seenKinds.add(c.kind);
    if (typeof c.description !== 'string' || c.description.trim().length === 0) {
      fail(identity, 'every advisory constraint requires a non-empty description');
    }
  }

  // --- mode neutrality (W045-AC06) --------------------------------------------------
  const modes = def.execution.supportedModes;
  if (modes.length !== 2 || modes[0] !== 'native' || modes[1] !== 'external') {
    fail(identity, `supportedModes must be exactly the symmetric ['native', 'external'] (found: [${modes.join(', ')}])`);
  }
  if (def.execution.semantics !== 'advisory') {
    fail(identity, `execution semantics must be 'advisory' (found: '${def.execution.semantics}')`);
  }

  // --- lifecycle + the EMPTY extension seam (W045-AC10/AC14) ------------------------
  if (!Number.isInteger(def.lifecycle.contractVersion) || def.lifecycle.contractVersion < 1) {
    fail(identity, 'lifecycle.contractVersion must be a positive integer');
  }
  if (def.lifecycle.status !== 'stable') {
    fail(identity, `lifecycle.status must be 'stable' (found: '${def.lifecycle.status}')`);
  }
  if (Object.keys(def.extensions.delegation).length > 0) {
    fail(identity, 'extensions.delegation must be EMPTY in WORK-045 (reserved for WORK-046)');
  }
  if (Object.keys(def.extensions.intelligence).length > 0) {
    fail(identity, 'extensions.intelligence must be EMPTY in WORK-045 (reserved for WORK-047)');
  }
}

function validateArtifact(identity: string, a: AgentRoleArtifactDescriptor): void {
  if (!KEBAB_CASE.test(a.name)) {
    fail(identity, `the artifact name '${a.name}' must be kebab-case`);
  }
  if (typeof a.description !== 'string' || a.description.trim().length === 0) {
    fail(identity, `the artifact '${a.name}' requires a non-empty description`);
  }
  if (typeof a.required !== 'boolean') {
    fail(identity, `the artifact '${a.name}' requires a boolean 'required' flag`);
  }
}

/** Every human-authored string of the definition (for the provider-token scan). */
function allContentStrings(def: AgentRoleDefinition): string[] {
  const out: string[] = [def.displayName, def.purpose, ...def.responsibilities];
  for (const c of def.advisoryConstraints) out.push(c.kind, c.description);
  for (const list of [def.expectedInputs, def.expectedOutputs] as const) {
    for (const a of list) out.push(a.name, a.description);
  }
  return out;
}

// ============================================================================
// THE CONTENT-DERIVED REVISION (W045-AC10)
// ============================================================================

/**
 * Canonical serialization of a role definition: recursively key-sorted,
 * deterministic JSON. The revision EXCLUDES itself (the lifecycle carries
 * contractVersion + status only when the digest is computed) — the digest
 * covers every other field, including the extension seam.
 */
export function canonicalRoleContent(
  def: Omit<AgentRoleDefinition, 'lifecycle'> & { lifecycle: { contractVersion: number; status: 'stable' } },
): string {
  return JSON.stringify(sortKeysDeep(def));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The content-derived revision digest (W045-AC10): deterministic SHA-256
 * over the canonical definition, truncated to 16 hex chars. ANY change to
 * the definition (responsibilities, capabilities, constraints, artifacts,
 * execution declaration, extensions) produces a DIFFERENT revision — a
 * historical (identity, revision) reference can never be silently
 * reinterpreted. Exported so consumers (and regression tests) can verify
 * revisions against content.
 */
export function computeRoleRevision(
  def: Omit<AgentRoleDefinition, 'lifecycle'> & { lifecycle: { contractVersion: number; status: 'stable' } },
): string {
  return createHash('sha256').update(canonicalRoleContent(def)).digest('hex').slice(0, 16);
}

// ============================================================================
// BUILD — validate → stamp → freeze (fail-closed at module load)
// ============================================================================

/** Recursively freeze an object graph (arrays frozen as arrays). */
function deepFreeze<T>(value: T): T {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

/**
 * Build the closed catalog: validate EVERY definition (fail-closed), verify
 * the closed-identity set against the declared order (W045-AC02), stamp the
 * content-derived revision (W045-AC10), and deep-freeze the result. The
 * returned catalog is IMMUTABLE application data — safe to share globally.
 */
export function buildAgentRoleCatalog(): readonly AgentRoleContract[] {
  // The closed-identity check: exactly the declared order, no extras, no
  // duplicates (W045-AC02).
  const identities = AGENT_ROLE_DEFINITIONS.map((d) => d.identity);
  if (identities.length !== AGENT_ROLE_CATALOG_ORDER.length) {
    throw new Error(
      `agent-role-catalog-invalid: the catalog must contain exactly ${AGENT_ROLE_CATALOG_ORDER.length} definitions (found ${identities.length}) — the closed initial catalog admits no extras`,
    );
  }
  for (let i = 0; i < AGENT_ROLE_CATALOG_ORDER.length; i += 1) {
    if (identities[i] !== AGENT_ROLE_CATALOG_ORDER[i]) {
      throw new Error(
        `agent-role-catalog-invalid: definition ${i} has identity '${identities[i]}' but the declared order requires '${AGENT_ROLE_CATALOG_ORDER[i]}' (the catalog is order-stable by construction)`,
      );
    }
  }
  if (new Set(identities).size !== identities.length) {
    throw new Error('agent-role-catalog-invalid: a role identity appears more than once');
  }

  const built = AGENT_ROLE_DEFINITIONS.map((def) => {
    validateAgentRoleDefinition(def);
    const contract: AgentRoleContract = {
      ...def,
      lifecycle: {
        contractVersion: def.lifecycle.contractVersion,
        revision: computeRoleRevision(def),
        status: def.lifecycle.status,
      },
    };
    return deepFreeze(contract);
  });
  return Object.freeze(built);
}

/**
 * The closed, validated, revision-stamped, deep-frozen initial catalog —
 * built ONCE at module load (fail-closed: an invalid definition aborts the
 * import). Shared immutable state: every resolution returns these exact
 * frozen objects (deterministic identity — W045-AC03).
 */
export const AGENT_ROLE_CATALOG: readonly AgentRoleContract[] = buildAgentRoleCatalog();

/** The stable identity list (the declared catalog order). */
export const AGENT_ROLE_IDENTITIES: readonly AgentRoleId[] = AGENT_ROLE_CATALOG_ORDER;
