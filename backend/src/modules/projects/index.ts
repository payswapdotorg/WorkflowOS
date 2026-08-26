/**
 * projects module — public interface.
 *
 * Canonical name: /projects
 * Responsibility (spec/architecture.md): Projects as the primary WorkflowOS container for a development effort.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-004: the project domain is now authoritative (PROJ-001). Evolved from
 * the WORK-002 minimal representation: adds lifecycle state, metadata, and a
 * provider-independent repository association contract (PROJ-AC-02/03). The
 * existing project-access relationship from WORK-002 is preserved.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectState,
  ProjectLifecycleTransition,
  ProjectAccess,
  GrantProjectAccessInput,
  ProjectRepository,
  ProjectAccessRepository,
  ProjectRepositoryAssociation,
  AssociateRepositoryInput,
  ProjectRepositoryAssociationRepository,
} from './internal/project.types.js';
// WORK-038: Project Baseline — the evidence-backed reconstruction of a
// repository WorkflowOS did NOT originally create. The baseline is a PROJECT
// artifact (stored THROUGH the existing /projects authority); it is NOT a
// second project/repo/architecture/requirements/workflow/verification/review
// authority. Provenance (observed/inferred/confirmed/proposed) is the central
// invariant; provenance is never silently promoted. The onboarding
// ORCHESTRATION (revision resolution + governed analysis) lives in the
// application-layer src/onboarding/ capability (not a module).
export type {
  BaselineProvenance,
  BaselineState,
  BaselineAnalysisMode,
  BaselineObservationKind,
  BaselineEvidenceSource,
  ProjectBaseline,
  BaselineObservation,
  BaselineEvidence,
  NewBaselineObservation,
  NewBaselineEvidence,
  RepositoryReadEnforcement,
  PersistencePolicySnapshot,
  PersistBaselineInput,
  PersistBaselineResult,
  EnsureBaselineInput,
  ProjectBaselineRepository,
  ProjectBaselineErrorCode,
} from './internal/project-baseline.types.js';
export {
  ProjectBaselineError,
  PROJECT_BASELINE_ERROR_CODES,
} from './internal/project-baseline.types.js';

/**
 * Public capabilities exposed by the /projects module to other modules.
 */
export interface ProjectsModuleApi {
  // future: additional project-domain methods
}

/**
 * Frozen module contract for /projects.
 */
export const projectsModule: ModuleContract & ProjectsModuleApi = {
  name: '/projects',
};

export default projectsModule;
