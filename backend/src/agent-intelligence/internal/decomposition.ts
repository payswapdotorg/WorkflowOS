/**
 * WORK-047 — the PURE delegation-decomposition rules (no I/O; fully
 * deterministic; task-profile-driven).
 *
 * The decomposition recommends WHICH WORK-045 roles should staff a WORK-046
 * delegation plan for a Work Item, with dependency edges — as ADVISORY DATA
 * (W047-AC09): the caller submits it through the EXISTING delegation plan
 * boundary, which validates roles/providers/dependencies fail-closed. This
 * module never creates a plan, never drives one, never executes anything.
 *
 * THE RULES (deterministic functions of the §15 ExecutionTaskProfile — each
 * recommended role carries its rule reason; each considered-but-not-
 * recommended role carries its rejection reason):
 *
 *   implementer          ALWAYS   — every Work Item requires implementation
 *   architect            iff architectureSensitivity === 'high'
 *   planner              iff complexity === 'high'
 *   tester               iff complexity !== 'low' (fail-safe under 'unknown')
 *   security-reviewer    iff securitySensitivity === 'high'
 *   performance-reviewer iff (terminalRequired || browserRequired) && complexity === 'high'
 *   ux-reviewer          never (the §15 profile exposes no UX axis — explicit
 *                         rejected alternative, never silently dropped)
 *   release-engineer     never (release engineering is a separate lifecycle
 *                         concern — explicit rejected alternative)
 *
 * DEPENDENCIES (acyclic by construction — a fixed topological shape):
 *
 *   architect  → []
 *   planner    → ['architect'] (when the architect is present, else [])
 *   implementer→ ['planner']   (when the planner is present, else [])
 *   tester     → ['implementer']
 *   security-reviewer    → ['implementer']
 *   performance-reviewer → ['implementer']
 *
 * HISTORICAL EVIDENCE ANNOTATES, NEVER DROPS (W047-AC10): the observed
 * role-history cells attach to the recommended units (success rate, sample,
 * window) and produce WARNINGS for poor observed success — but a
 * task-profile-required role is NEVER removed and evidence NEVER adds a role
 * the rules did not select. Every recommended role is resolved through the
 * WORK-045 catalog and pinned with its revision; a rule naming an unknown
 * role fails closed with a typed error.
 */

import type { AgentRoleId } from '../../agent-roles/index.js';
import type { ExecutionTaskProfile } from '../../execution-policy/index.js';
import type {
  DelegationRoleHistoryCell,
  EvidenceContribution,
  IntelligenceReason,
  IntelligenceRejectedRole,
  IntelligenceUnitRecommendation,
} from '../types.js';
import { AgentIntelligenceError } from '../types.js';

// ============================================================================
// The rule table (deterministic; the single source of decomposition truth)
// ============================================================================

/** One decomposition rule: role + the §15 predicate + the reasons. */
export interface DecompositionRule {
  readonly role: AgentRoleId;
  /** The deterministic predicate over the §15 task profile. */
  readonly applies: (profile: ExecutionTaskProfile) => boolean;
  /** Why the role is recommended (when it applies). */
  readonly recommendationReason: (profile: ExecutionTaskProfile) => string;
  /** Why the role is NOT recommended (when it does not apply). */
  readonly rejectionReason: string;
  /** The unit's dependency edges (unit keys; filtered to present units). */
  readonly dependsOn: readonly AgentRoleId[];
}

/** The declared rule order — deterministic unit ordering (the catalog order). */
export const DECOMPOSITION_RULES: readonly DecompositionRule[] = [
  {
    role: 'implementer',
    applies: () => true,
    recommendationReason: () => 'every Work Item requires an implementation unit (the always-present role)',
    rejectionReason: 'unreachable — the implementer is always recommended',
    dependsOn: ['planner'],
  },
  {
    role: 'architect',
    applies: (p) => p.architectureSensitivity === 'high',
    recommendationReason: () => 'the task profile declares architecture sensitivity high — an upfront architecture unit is recommended',
    rejectionReason: 'the task profile does not declare high architecture sensitivity (no architecture unit indicated)',
    dependsOn: [],
  },
  {
    role: 'planner',
    applies: (p) => p.complexity === 'high',
    recommendationReason: () => 'the task profile declares high complexity — a planning unit before implementation is recommended',
    rejectionReason: 'the task profile does not declare high complexity (a dedicated planning unit is not indicated)',
    dependsOn: ['architect'],
  },
  {
    role: 'tester',
    applies: (p) => p.complexity !== 'low',
    recommendationReason: (p) =>
      p.complexity === 'unknown'
        ? 'the task complexity is unknown — a testing unit is recommended fail-safe (the safe choice under uncertainty)'
        : 'the task profile declares medium-or-higher complexity — a testing unit after implementation is recommended',
    rejectionReason: 'the task profile declares low complexity (a dedicated testing unit is not indicated)',
    dependsOn: ['implementer'],
  },
  {
    role: 'security-reviewer',
    applies: (p) => p.securitySensitivity === 'high',
    recommendationReason: () => 'the task profile declares security sensitivity high — a security review unit after implementation is recommended',
    rejectionReason: 'the task profile does not declare high security sensitivity (no security review unit indicated)',
    dependsOn: ['implementer'],
  },
  {
    role: 'performance-reviewer',
    applies: (p) => (p.terminalRequired || p.browserRequired) && p.complexity === 'high',
    recommendationReason: () => 'the task profile declares high complexity with terminal/browser requirements — a performance review unit after implementation is recommended',
    rejectionReason: 'the task profile does not combine high complexity with terminal/browser requirements (no performance review unit indicated)',
    dependsOn: ['implementer'],
  },
  {
    role: 'ux-reviewer',
    applies: () => false,
    recommendationReason: () => 'unreachable — no §15 task-profile axis indicates UX review',
    rejectionReason: 'the §15 ExecutionTaskProfile exposes no UX axis — a UX review unit cannot be indicated by the current task characteristics (an explicit rejected alternative, never silently dropped)',
    dependsOn: ['implementer'],
  },
  {
    role: 'release-engineer',
    applies: () => false,
    recommendationReason: () => 'unreachable — release engineering is a separate lifecycle concern',
    rejectionReason: 'release engineering is a separate lifecycle concern outside the delegation decomposition of a single Work Item (an explicit rejected alternative, never silently dropped)',
    dependsOn: ['implementer'],
  },
];

/** The observed role-history threshold for a poor-success warning (deterministic). */
export const POOR_ROLE_SUCCESS_THRESHOLD = 0.5;
/** The minimum role-history sample before a poor-success warning is raised (never warn on thin evidence). */
export const ROLE_WARNING_MIN_SAMPLE = 3;

// ============================================================================
// The role-history lookup (pure)
// ============================================================================

/** The role-history cell key: `role/provider/mode` (aggregated over providers/modes for the unit annotation). */
export function roleHistoryFor(
  cells: readonly DelegationRoleHistoryCell[],
  roleId: AgentRoleId,
): DelegationRoleHistoryCell[] {
  return cells.filter((c) => c.roleId === roleId);
}

/** Aggregate a role's observed history into one contribution (deterministic). */
export function aggregateRoleHistory(
  cells: readonly DelegationRoleHistoryCell[],
  roleId: AgentRoleId,
): EvidenceContribution | null {
  const own = roleHistoryFor(cells, roleId);
  if (own.length === 0) return null;
  let attempts = 0;
  let succeeded = 0;
  let first = own[0]!.firstObservedAt;
  let last = own[0]!.lastObservedAt;
  for (const c of own) {
    attempts += c.attempts;
    succeeded += c.succeeded;
    if (c.firstObservedAt < first) first = c.firstObservedAt;
    if (c.lastObservedAt > last) last = c.lastObservedAt;
  }
  return {
    cell: `${roleId}/*/*`,
    kind: 'role-history',
    attempts,
    succeeded,
    successRate: attempts > 0 ? succeeded / attempts : null,
    firstObservedAt: first,
    lastObservedAt: last,
  };
}

// ============================================================================
// The decomposition (pure; fail-closed on unknown roles)
// ============================================================================

export interface DecompositionInput {
  /** The §15 task profile (carried through the consumed routing result). */
  readonly taskProfile: ExecutionTaskProfile;
  /** The observed role history (annotations; NEVER drops or adds roles). */
  readonly roleCells: readonly DelegationRoleHistoryCell[];
  /** Resolves a role identity through the WORK-045 catalog (fail-closed port). */
  readonly resolveRole: (identity: string) => { readonly role: { readonly identity: string; readonly lifecycle: { readonly revision: string } } } | null;
  /** The rules to apply (defaults to DECOMPOSITION_RULES; injectable for the corrupted-rule fail-closed test). */
  readonly rules?: readonly DecompositionRule[];
}

export interface DecompositionOutput {
  readonly units: readonly IntelligenceUnitRecommendation[];
  readonly rejectedRoles: readonly IntelligenceRejectedRole[];
  readonly warnings: readonly string[];
}

/**
 * Compute the advisory decomposition. Pure and deterministic: the same task
 * profile + role cells + catalog → the same units, in the declared rule
 * order. Every recommended role is resolved through the catalog and pinned
 * with its revision; a rule naming an unknown role fails closed.
 */
export function computeDecomposition(input: DecompositionInput): DecompositionOutput {
  const rules = input.rules ?? DECOMPOSITION_RULES;
  const profile = input.taskProfile;
  const selected = rules.filter((r) => r.applies(profile));
  const selectedRoles = new Set(selected.map((r) => r.role));

  const units: IntelligenceUnitRecommendation[] = [];
  for (const rule of selected) {
    // FAIL-CLOSED (W047-AC03/AC06): every recommended role MUST resolve in
    // the WORK-045 catalog — an unknown role is a typed error, never a
    // silent pass-through.
    const resolution = input.resolveRole(rule.role);
    if (!resolution) {
      throw new AgentIntelligenceError(
        'agent-intelligence-unknown-role',
        `the decomposition rule named role "${rule.role}" which does not resolve in the WORK-045 catalog — failing closed (the intelligence layer authors no role definitions)`,
      );
    }
    // The dependency edges refer ONLY to units present in the same plan
    // (filtered to the selected roles — WORK-046 same-plan semantics).
    const dependsOn = rule.dependsOn.filter((dep) => selectedRoles.has(dep));
    const why: IntelligenceReason[] = [
      { dimension: 'task_profile', detail: rule.recommendationReason(profile) },
    ];
    // The observed role-history ANNOTATION (W047-AC10 — evidence never drops the unit).
    const history = aggregateRoleHistory(input.roleCells, rule.role);
    if (history && history.attempts > 0) {
      why.push({
        dimension: 'historical_success',
        detail: `observed delegation history for the ${rule.role} role: ${history.succeeded}/${history.attempts} attempts succeeded (window ${history.firstObservedAt.toISOString()} → ${history.lastObservedAt.toISOString()})`,
      });
    } else {
      why.push({
        dimension: 'unavailable',
        detail: `no observed delegation history for the ${rule.role} role in this project — the recommendation rests on the task-profile rule alone (explicitly uncertain; never fabricated)`,
      });
    }
    units.push({
      unitKey: rule.role,
      role: rule.role,
      roleRevision: resolution.role.lifecycle.revision,
      mode: null,        // assigned by the service from the intelligence ranking
      provider: null,    // (null when no eligible candidates — explicit)
      model: null,
      dependsOn,
      why,
      roleHistory: history,
    });
  }

  // The rejected alternatives — explicit, with reasons (never silently dropped).
  const rejectedRoles: IntelligenceRejectedRole[] = rules
    .filter((r) => !r.applies(profile))
    .map((r) => ({ role: r.role, reason: r.rejectionReason }));

  // The poor-observed-success WARNINGS (evidence annotates; never drops).
  const warnings: string[] = [];
  for (const unit of units) {
    const h = unit.roleHistory;
    if (h && h.attempts >= ROLE_WARNING_MIN_SAMPLE && h.successRate !== null && h.successRate < POOR_ROLE_SUCCESS_THRESHOLD) {
      warnings.push(
        `the ${unit.role} role shows poor observed delegation success (${h.succeeded}/${h.attempts} = ${(h.successRate * 100).toFixed(0)}% over ${h.attempts} attempts) — the role stays recommended (the task-profile rule dominates; historical evidence annotates, never drops), consider review gates when submitting the plan`,
      );
    }
  }

  return { units, rejectedRoles, warnings };
}
