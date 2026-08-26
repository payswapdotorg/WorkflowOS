/**
 * maintenance module — public interface.
 *
 * Canonical name: WORK-041 (Maintenance + Project Health Engine).
 * Responsibility (spec/work-items.md): Detect dependency vulnerabilities, CI
 * regressions, runtime changes, security advisories, compatibility issues,
 * performance regressions, architecture drift, technical debt, and operational
 * risks; create and prioritize maintenance Work Items.
 *
 * This directory is NOT a frozen module (it is not under src/modules/). It is
 * an APPLICATION/MAINTENANCE CAPABILITY (analogous to src/onboarding/,
 * src/repository-intelligence/, src/development-planner/) that COMPOSES the
 * EXISTING domain authorities + the WORK-040 planner. The maintenance
 * capability owns NO tables; its evidence is embedded in the authoritative
 * Work Item's existing `metadata.planner` JSONB (field `metadata.planner.maintenance`).
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this capability; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * The barrel is TYPES-ONLY — no concrete implementations are exported (the
 * composition root in src/app.ts wires the concrete DefaultMaintenanceService +
 * CiRegressionDetector + ArchitectureDriftDetector + AdvisoryDetector +
 * MaintenanceRunJobHandler by importing from internal/, the sanctioned wiring
 * boundary). This mirrors the WORK-040 development-planner barrel convention +
 * the frozen-module barrel rule.
 *
 * AUTHORITY BOUNDARY: the maintenance capability is NOT a second Work Item
 * authority. It is a TRUSTED INTERNAL PRODUCER that feeds the EXISTING WORK-040
 * planner. Its detectors produce PlanningSignal[] (the full vocabulary) +
 * call DevelopmentPlannerService.evaluate DIRECTLY (programmatically). The
 * planner creates the authoritative Work Items through the existing
 * WorkItemRepository.create (the single creation path) with the deterministic
 * proposedWorkItemId as the dedup key. The maintenance capability NEVER calls
 * WorkItemRepository.create directly, NEVER mutates the dependency graph, NEVER
 * mutates workflow / verification / review state, NEVER starts execution,
 * NEVER selects a provider.
 */
// Maintenance-specific types owned by this capability.
export type {
  AdvisoryRecord,
  AdvisoryEcosystem,
  AdvisorySource,
  MaintenanceDetector,
  MaintenanceDetectInput,
  MaintenanceContext,
  MaintenanceService,
  MaintenanceRunInput,
  MaintenanceRunResult,
  MaintenanceSignalSummary,
  MaintenanceServiceDeps,
  MaintenanceRunJobPayload,
} from './maintenance.types.js';

// Re-exported from @development-planner (the planner owns the signal shape).
// These are re-exported through this barrel so capability consumers import
// from @maintenance only (single surface).
export type {
  DevelopmentPlannerService,
  PlanningContext,
  PlanningSignal,
  PlanningEvaluateResult,
  PlanningRecommendationSummary,
  PlanningMetadataPayload,
  MaintenanceCategory,
  MaintenanceSignalMetadata,
} from '@development-planner/index.js';

export type {
  ProjectRepository,
  ProjectBaselineRepository,
} from '@modules/projects/index.js';
export type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
export type {
  WorkItemRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
export type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
export type { CiEvidenceIngestionRepository } from '@modules/github/index.js';
export type { Logger } from '@platform/index.js';

export {
  MAINTENANCE_RUN_JOB_TYPE,
  MAINTENANCE_RUN_REDELIVERY_POLICY,
  MAINTENANCE_VERSION,
} from './maintenance.types.js';
