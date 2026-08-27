/**
 * WORK-045 — Agent Roles (public barrel).
 *
 * The agent-roles domain is an APPLICATION-LAYER ROLE MODEL that lives at
 * `src/agent-roles/` (mirrors the §34 benchmark / execution-policy /
 * execution-routing pattern: NOT the 18th frozen module — it CONSUMES the
 * frozen modules' public vocabulary and adds NO new authority).
 *
 * Boundary contract (static-architecture checks enforce):
 *   - imports the WORK-043 capability vocabulary from
 *     ../execution-policy/index.js (the PUBLIC barrel — never internal/)
 *     and ExecutionMode from @modules/agents (the public barrel)
 *   - NEVER imports pg / @octokit / provider SDKs / provider adapters
 *   - NEVER persists or reads provider credentials, tokens, cookies, secrets
 *   - NEVER evaluates capabilities/constraints (no second eligibility,
 *     ranking, or policy engine — WORK-043/WORK-044/WORK-037 stay the
 *     authorities) and NEVER dispatches or selects a provider
 *   - NEVER mutates workflow state (roles are advisory configuration, not
 *     workflow authority)
 *   - contains NO provider/model tokens (provider-independent contracts)
 *
 * THE FORWARD DEPENDENCY SLICE (Work Order WORK-045):
 *
 *   WORK-044 (routing) → WORK-045 Agent Roles → WORK-046 Delegation
 *        → WORK-047 Agent Intelligence
 */
export type {
  AgentRoleId,
  AgentRoleCatalogOrder,
  AgentRoleConstraintKind,
  AgentRoleAdvisoryConstraint,
  AgentRoleArtifactDescriptor,
  AgentRoleExecutionDeclaration,
  AgentRoleLifecycle,
  AgentRoleExtensions,
  AgentRoleContract,
  AgentRoleDeclarationSemantics,
  AgentRoleResolution,
  AgentRoleCatalogService,
} from './types.js';

export { DefaultAgentRoleCatalogService } from './internal/agent-role-catalog.service.js';
export { AGENT_ROLE_DECLARATION_SEMANTICS } from './internal/agent-role-catalog.service.js';

export {
  AGENT_ROLE_CATALOG,
  AGENT_ROLE_IDENTITIES,
  buildAgentRoleCatalog,
  canonicalRoleContent,
  computeRoleRevision,
  validateAgentRoleDefinition,
} from './internal/role-catalog.js';
export { AGENT_ROLE_CATALOG_ORDER, type AgentRoleDefinition } from './internal/role-definitions.js';
