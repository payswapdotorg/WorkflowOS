/**
 * development-planner module — public interface.
 *
 * Canonical name: WORK-040 (Continuous Development Planner).
 * Responsibility (spec/work-items.md): Continuously turn product goals,
 * technical debt, refactors, performance opportunities, developer requests,
 * and dependency-aware priorities into governed Work Items.
 *
 * This directory is NOT a frozen module (it is not under src/modules/). It is
 * an APPLICATION/PLANNING CAPABILITY (analogous to src/onboarding/,
 * src/repository-intelligence/, src/execution-policy/, src/benchmark/). It
 * COMPOSES the EXISTING domain authorities (/work-items, /architecture,
 * /requirements, /projects) to decide "what should be done next?" and
 * convergently create authoritative Work Items THROUGH the existing
 * /work-items WorkItemRepository.create. The planner owns NO tables; the
 * planning evidence is embedded in the authoritative Work Item's existing
 * `metadata` JSONB (field `metadata.planner`).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this capability; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * The barrel is TYPES-ONLY — no concrete implementations are exported (the
 * composition root in src/app.ts wires the concrete
 * DefaultDevelopmentPlannerService + DeterministicPlanningPrioritizer +
 * PlanningEvaluateJobHandler by importing from internal/, the sanctioned
 * wiring boundary). This mirrors the WORK-039 repository-intelligence barrel
 * convention + the frozen-module barrel rule.
 *
 * AUTHORITY BOUNDARY: the planner is NOT a second Work Item authority. The
 * authoritative Work Item state lives in wfos_work_items (the existing
 * /work-items authority). The planner CREATES Work Items through the existing
 * WorkItemRepository.create (the single creation path) with the deterministic
 * proposedWorkItemId as the dedup key. The existing
 * UNIQUE(architecture_version_id, work_item_id) DB constraint is the
 * persistence-level dedup fence — two concurrent planner runs evaluating the
 * same signal converge to a single Work Item (no duplicates). The planner
 * NEVER mutates the dependency graph, NEVER mutates workflow / verification /
 * review state, NEVER starts execution, NEVER selects a provider.
 */
export type {
  PlanningProvenance,
  PlanningEvidenceKind,
  PlanningEvidenceRef,
  PlanningSignalKind,
  PlanningSignal,
  PlanningPriority,
  PlanningPriorityFactorKind,
  PlanningPriorityFactor,
  PlanningCandidate,
  PlanningRecommendationStatus,
  PlanningRecommendation,
  PlanningRecommendationSummary,
  PlanningMetadataPayload,
  PlanningEvaluateInput,
  PlanningEvaluateResult,
  PlanningContext,
  PlanningPrioritizer,
  DevelopmentPlannerService,
  DevelopmentPlannerServiceDeps,
  PlanningEvaluateJobPayload,
  // WORK-041: maintenance metadata types re-exported so the maintenance
  // capability's barrel can re-export them (single surface for capability
  // consumers).
  MaintenanceCategory,
  MaintenanceSignalMetadata,
} from './development-planner.types.js';

// Re-export the authority types so capability consumers import from this
// barrel only (the route, the future execution layer, the tests). These are
// re-exported DIRECTLY from the authority barrels (NOT from
// development-planner.types.js — the types file imports them for use; the
// barrel re-exports the canonical source).
export type {
  WorkItemRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
export type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
export type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';

export {
  PLANNING_EVALUATE_JOB_TYPE,
  PLANNING_EVALUATE_REDELIVERY_POLICY,
  PLANNER_VERSION,
} from './development-planner.types.js';
