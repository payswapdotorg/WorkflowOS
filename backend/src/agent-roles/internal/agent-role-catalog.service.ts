/**
 * WORK-045 — the default agent-role catalog service (internal).
 *
 * The deterministic resolution layer over the closed static catalog:
 *   - `resolveRole(identity)` — O(1) Map lookup by stable identity; repeated
 *     calls return the IDENTICAL deep-frozen resolution object (W045-AC03);
 *     unknown identity → null (no fallback role — the caller maps to 404);
 *   - `listRoles()` — the DECLARED catalog order (W045-AC03), never object
 *     iteration order.
 *
 * Deliberately SYNCHRONOUS and CONTEXT-FREE: the service accepts no tenant,
 * project, organization, user, or request context of any kind — there is no
 * tenant-scoped role metadata to leak (W045-AC11), and no input that could
 * affect the result other than the stable identity (W045-AC03). Request
 * scoping + authorization live in the HTTP route layer, per the one-way
 * dependency invariant.
 */
import type {
  AgentRoleCatalogService,
  AgentRoleDeclarationSemantics,
  AgentRoleResolution,
} from '../types.js';
import { AGENT_ROLE_CATALOG } from './role-catalog.js';

/**
 * The advisory-vs-authoritative declaration semantics surfaced on EVERY
 * resolution (W045-AC13). A single frozen constant — the semantics are
 * properties of the WORK-045 boundary itself, not of any one role.
 */
export const AGENT_ROLE_DECLARATION_SEMANTICS: AgentRoleDeclarationSemantics = Object.freeze({
  requiredCapabilities: 'declarative-requirement',
  requiredCapabilitiesEvaluatedBy: 'execution-policy (WORK-043) at execution time',
  advisoryConstraints: 'advisory',
  supportedExecutionModes: 'advisory',
  dispatchAuthority: 'none — the role layer never dispatches or selects',
  versioning: 'contractVersion + content-derived revision',
} satisfies AgentRoleDeclarationSemantics);

export class DefaultAgentRoleCatalogService implements AgentRoleCatalogService {
  private readonly catalog: readonly AgentRoleResolution[];

  constructor() {
    // Built once: the frozen catalog + the shared frozen semantics block.
    // The Map preserves O(1) identity lookup while listRoles() keeps the
    // DECLARED order (the array index) — neither depends on iteration order.
    this.catalog = AGENT_ROLE_CATALOG.map((role) =>
      Object.freeze({ role, declarationSemantics: AGENT_ROLE_DECLARATION_SEMANTICS }),
    );
  }

  resolveRole(identity: string): AgentRoleResolution | null {
    // Linear scan over the closed 8-entry catalog — deterministic, trivially
    // fast, and avoids constructing an iteration-order-derived index. The
    // FIRST (and only) match by identity is returned.
    for (const resolution of this.catalog) {
      if (resolution.role.identity === identity) return resolution;
    }
    return null;
  }

  listRoles(): readonly AgentRoleResolution[] {
    // The declared catalog order — a fresh readonly view each call, same
    // frozen resolution objects (identity-stable — W045-AC03).
    return this.catalog;
  }
}
