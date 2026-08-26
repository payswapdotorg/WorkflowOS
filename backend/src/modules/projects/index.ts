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
  PersistencePolicySource,
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
// WORK-039: Repository and Context Intelligence — the revision-bound context
// index + the explainable, provenance-preserving context-item layer. Like
// ProjectBaseline, the context index is a PROJECT artifact stored THROUGH
// the existing /projects authority (the single project authority). It is
// NOT a second project/repo/architecture/requirements/workflow/verification/
// review authority. The context-intelligence ORCHESTRATION (the ranker +
// the retrieval service + the baseline-context source + the governed host
// inspector) lives in the application-layer src/repository-intelligence/
// capability (not a module, not an authority). Provenance re-uses the
// WORK-038 vocabulary (observed/inferred/confirmed/proposed); the ranker
// NEVER promotes provenance. Repository revision is fundamental — an index
// is pinned to a concrete baseline_commit_sha, never silently swapped.
export type {
  ContextIndexState,
  ContextIndexQueryKind,
  ContextItemKind,
  ContextItemSource,
  ContextItemProvenance,
  ProjectContextIndex,
  ContextItem,
  NewContextItem,
  EnsureContextIndexInput,
  EnsureContextIndexResult,
  MarkContextIndexCompleteInput,
  MarkContextIndexCompleteResult,
  MarkContextIndexFailedInput,
  MarkContextIndexStaleInput,
  ProjectContextIndexRepository,
  RepositoryIntelligenceErrorCode,
} from './internal/project-context-index.types.js';
export {
  RepositoryIntelligenceError,
  REPOSITORY_INTELLIGENCE_ERROR_CODES,
} from './internal/project-context-index.types.js';

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
