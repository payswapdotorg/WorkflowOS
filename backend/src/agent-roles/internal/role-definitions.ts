/**
 * WORK-045 — the CLOSED initial role catalog (internal definitions).
 *
 * Deterministic application data — the Work Order's preferred bounded
 * representation ("a static/immutable catalog"): no persistence, no
 * migration, no tenant-scoped configuration. Every definition below is
 * validated + deep-frozen + revision-stamped at module load by
 * `role-catalog.ts` (fail-closed: an invalid definition throws at import).
 *
 * AUTHORED CONTENT RULES (enforced structurally downstream):
 *   - provider/model tokens are forbidden in every string field (W045-AC04);
 *   - requiredCapabilities use the WORK-043 vocabulary EXCLUDING the
 *     mode-selecting kinds 'native_api'/'external_ui' (W045-AC06);
 *   - execution.supportedModes is the SYMMETRIC ['native', 'external'] set
 *     with advisory semantics for EVERY role (W045-AC06);
 *   - extensions are EMPTY (reserved for WORK-046/047 — W045-AC14).
 */
import type { ExecutionMode } from '@modules/agents';
import type { CapabilityRequirement } from '../../execution-policy/index.js';
import type {
  AgentRoleAdvisoryConstraint,
  AgentRoleArtifactDescriptor,
  AgentRoleConstraintKind,
  AgentRoleContract,
  AgentRoleId,
  AgentRoleExecutionDeclaration,
  AgentRoleExtensions,
} from '../types.js';

// The mode-NEUTRAL execution declaration shared by every catalog role
// (W045-AC06: both modes first-class; advisory only; never dispatches).
const NEUTRAL_EXECUTION: AgentRoleExecutionDeclaration = {
  supportedModes: ['native', 'external'] as readonly ExecutionMode[],
  semantics: 'advisory',
};

// The EMPTY forward-compatibility seam (W045-AC14: reserved for
// WORK-046 delegation / WORK-047 intelligence; empty in WORK-045).
const EMPTY_EXTENSIONS: AgentRoleExtensions = {
  delegation: Object.freeze({}) as Readonly<Record<string, never>>,
  intelligence: Object.freeze({}) as Readonly<Record<string, never>>,
};

function constraint(kind: AgentRoleConstraintKind, description: string): AgentRoleAdvisoryConstraint {
  return { kind, description };
}

function artifact(name: string, description: string, required = true): AgentRoleArtifactDescriptor {
  return { name, description, required };
}

/** The role definition shape BEFORE revision stamping (revision is derived). */
export type AgentRoleDefinition = Omit<AgentRoleContract, 'lifecycle'> & {
  readonly lifecycle: {
    readonly contractVersion: number;
    readonly status: 'stable';
  };
};

/**
 * The DECLARED catalog order (W045-AC03: `listRoles()` returns exactly this
 * order — independent of object iteration; there is no database ordering).
 */
export const AGENT_ROLE_CATALOG_ORDER: readonly AgentRoleId[] = [
  'architect',
  'planner',
  'implementer',
  'tester',
  'security-reviewer',
  'performance-reviewer',
  'ux-reviewer',
  'release-engineer',
];

/**
 * The closed initial catalog (Work Order "Initial role catalog"): the eight
 * required role identities, each authored with its full contract.
 */
export const AGENT_ROLE_DEFINITIONS: readonly AgentRoleDefinition[] = [
  // --- architect -----------------------------------------------------------
  {
    identity: 'architect',
    displayName: 'Architect',
    purpose:
      'Designs system structure and keeps engineering work aligned with the frozen architecture and its authority boundaries.',
    responsibilities: [
      'Translate requirements and constraints into architecture and module-boundary decisions.',
      'Propose work-item decomposition that respects the frozen module contracts.',
      'Review structural risk (coupling, authority leakage, migration collisions) before implementation.',
      'Record architecture decision rationale so verification and review can check it.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'architecture-sensitive',
        'Architect output can change module boundaries and authority placement; structural decisions deserve explicit review.',
      ),
    ],
    expectedInputs: [
      artifact('work-order', 'The approved objective, scope, and out-of-scope boundaries.'),
      artifact('architecture-version', 'The current frozen architecture the design must respect.'),
      artifact('requirements-and-criteria', 'The requirements and acceptance criteria the design must satisfy.'),
    ],
    expectedOutputs: [
      artifact('architecture-decision-records', 'The decisions taken, with rationale and rejected alternatives.'),
      artifact('work-item-decomposition', 'The proposed work items with boundaries and dependency order.'),
      artifact('structural-risk-assessment', 'The coupling, authority-leakage, and migration risks identified.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- planner --------------------------------------------------------------
  {
    identity: 'planner',
    displayName: 'Planner',
    purpose:
      'Turns an approved objective into a sequenced, dependency-ordered implementation plan that stays inside the Work Order scope.',
    responsibilities: [
      'Decompose the work order into ordered implementation steps with explicit dependencies.',
      'Identify the verification criteria and review checkpoints of each step.',
      'Surface assumptions, unknowns, and stop conditions before execution begins.',
      'Keep the plan inside the Work Order scope — no scope creep.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'human-intervention-permitted',
        'Plan validation benefits from a human check before implementation commits to it.',
      ),
    ],
    expectedInputs: [
      artifact('work-order', 'The objective, scope, and out-of-scope boundaries to plan against.'),
      artifact('architecture-context', 'The architecture constraints the plan must respect.'),
      artifact('acceptance-criteria', 'The criteria each planned step ultimately must satisfy.'),
    ],
    expectedOutputs: [
      artifact('implementation-plan', 'The ordered steps with dependencies and estimates.'),
      artifact('verification-checkpoints', 'What evidence each step must produce before it counts as done.'),
      artifact('assumptions-and-stop-conditions', 'The assumptions made and the conditions that halt the plan.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- implementer ------------------------------------------------------------
  {
    identity: 'implementer',
    displayName: 'Implementer',
    purpose:
      'Executes the implementation plan: writes the code and keeps every change inside the authorized scope.',
    responsibilities: [
      'Implement each planned step against the current architecture version.',
      'Keep changes inside the Work Order scope and its file boundaries.',
      'Run the mandated local checks (typecheck, lint, tests) before declaring a step complete.',
      'Report the honest completion state with evidence — never claim unverified work.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access', 'terminal'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'human-intervention-discouraged',
        'Implementation steps should complete without interruption; blockers surface through the workflow instead.',
      ),
    ],
    expectedInputs: [
      artifact('implementation-plan', 'The ordered steps to execute.'),
      artifact('work-order', 'The authoritative scope and out-of-scope boundaries.'),
      artifact('implementation-context', 'The repository context the changes apply to.'),
    ],
    expectedOutputs: [
      artifact('code-changes', 'The implementation diff, inside the authorized scope.'),
      artifact('local-verification-evidence', 'The typecheck, lint, and test results demonstrating the change.'),
      artifact('completion-report', 'The honest per-step completion state with evidence.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- tester -----------------------------------------------------------------
  {
    identity: 'tester',
    displayName: 'Tester',
    purpose:
      'Proves behavior with executable evidence: tests that fail on the defect and pass on the fix.',
    responsibilities: [
      'Write regression tests that reproduce defects before fixes land.',
      'Cover acceptance criteria and boundary conditions.',
      'Keep tests deterministic and scoped to the verified behavior.',
      'Report coverage gaps honestly.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access', 'terminal'] as readonly CapabilityRequirement[],
    advisoryConstraints: [],
    expectedInputs: [
      artifact('acceptance-criteria', 'The behaviors that must be proven.'),
      artifact('implementation-changes', 'The diff the tests must exercise.'),
      artifact('defect-reports', 'The reported defects to reproduce as regressions.'),
    ],
    expectedOutputs: [
      artifact('regression-tests', 'The tests proving the required behavior.'),
      artifact('test-execution-evidence', 'The executed results (pass/fail) with their environment.'),
      artifact('coverage-report', 'What is covered and where gaps remain.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- security-reviewer --------------------------------------------------------
  {
    identity: 'security-reviewer',
    displayName: 'Security Reviewer',
    purpose:
      'Reviews changes for security defects: injection, authorization bypass, secret leakage, and unsafe boundaries.',
    responsibilities: [
      'Review diffs against the platform security invariants (authority, credentials, injection).',
      'Flag secret-handling violations and unsafe input flows.',
      'Produce findings with severity and concrete remediation guidance.',
      'Re-check remediations until findings close.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'security-sensitive',
        'Security findings gate release readiness; treat with elevated scrutiny.',
      ),
    ],
    expectedInputs: [
      artifact('code-changes', 'The diff under review.'),
      artifact('security-invariants', 'The security policy and invariants the changes must uphold.'),
    ],
    expectedOutputs: [
      artifact('security-findings', 'The findings with severity and affected locations.'),
      artifact('remediation-guidance', 'The concrete fix for each finding.'),
      artifact('remediation-verification', 'The re-check result for each remediated finding.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- performance-reviewer -------------------------------------------------------
  {
    identity: 'performance-reviewer',
    displayName: 'Performance Reviewer',
    purpose:
      'Reviews changes for performance regressions and resource risks.',
    responsibilities: [
      'Identify algorithmic and query-level regression risks in the diff.',
      'Require measurements — not guesses — for claimed performance improvements.',
      'Flag unbounded growth, N+1, and lock-contention patterns.',
      'Tie findings to observable thresholds where they exist.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access'] as readonly CapabilityRequirement[],
    advisoryConstraints: [],
    expectedInputs: [
      artifact('code-changes', 'The diff under review.'),
      artifact('performance-baselines', 'The budgets or baselines changes are compared against.'),
    ],
    expectedOutputs: [
      artifact('performance-findings', 'The regression risks with their evidence.'),
      artifact('measurement-requirements', 'The measurements required to accept a performance claim.'),
      artifact('regression-assessment', 'The overall verdict on the change performance risk.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- ux-reviewer --------------------------------------------------------------------
  {
    identity: 'ux-reviewer',
    displayName: 'UX Reviewer',
    purpose:
      'Reviews user-facing changes for usability, accessibility, and consistency.',
    responsibilities: [
      'Evaluate flows for clarity, error recovery, and accessibility.',
      'Check responsive behavior and interaction feedback.',
      'Verify consistency with the established UI patterns.',
      'Report issues with reproduction steps.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access', 'browser'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'human-intervention-permitted',
        'Usability judgments are subjective; human confirmation strengthens the verdict.',
      ),
    ],
    expectedInputs: [
      artifact('ui-changes', 'The user-facing diff under review.'),
      artifact('design-references', 'The established patterns and guidelines to check against.'),
      artifact('user-flows', 'The flows the changes affect.'),
    ],
    expectedOutputs: [
      artifact('ux-findings', 'The usability and consistency issues found.'),
      artifact('accessibility-assessment', 'The accessibility evaluation of the changes.'),
      artifact('reproduction-steps', 'How to reproduce each reported issue.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
  // --- release-engineer -------------------------------------------------------------------
  {
    identity: 'release-engineer',
    displayName: 'Release Engineer',
    purpose:
      'Prepares verified work for release: versioning, changelogs, migration safety, and release gates.',
    responsibilities: [
      'Assemble release content from verified work items.',
      'Check migration ordering and data safety before release.',
      'Prepare changelogs and version metadata.',
      'Verify the release gates (CI, verification, review sign-offs) are green.',
    ],
    requiredCapabilities: ['coding_agent', 'repository_access', 'terminal'] as readonly CapabilityRequirement[],
    advisoryConstraints: [
      constraint(
        'human-intervention-permitted',
        'The release go/no-go decision benefits from explicit human confirmation.',
      ),
    ],
    expectedInputs: [
      artifact('verified-work-items', 'The work items cleared for release consideration.'),
      artifact('release-policy', 'The versioning and release rules to apply.'),
      artifact('migration-manifest', 'The migrations the release carries, in order.'),
    ],
    expectedOutputs: [
      artifact('release-manifest', 'The assembled release content and version.'),
      artifact('changelog', 'The human-readable record of what changed.'),
      artifact('release-readiness-report', 'The state of every release gate before shipping.'),
    ],
    execution: NEUTRAL_EXECUTION,
    lifecycle: { contractVersion: 1, status: 'stable' },
    extensions: EMPTY_EXTENSIONS,
  },
];
