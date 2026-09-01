/**
 * V2-002 — Workflow Repository + Immutable Versioning: the public module
 * surface.
 *
 * Structure (mirrors the src/orchestration template): public contracts in
 * `types.ts`, deterministic derivations / PostgreSQL persistence / the
 * visibility policy / the service in `internal/*` (private — the architecture
 * boundary suite enforces that nothing outside this directory reaches into
 * `internal/`).
 *
 * Consumers (the API route, the tests, later Work Orders) import ONLY from
 * this barrel.
 *
 * BOUNDARY REMINDER (constitution §19 + V2-CTRL-003): version content is
 * OPAQUE here; `computeContentDigest` is the CONTENT digest (immutability /
 * convergence proof), NOT the semantic digest (V2-003 owns that); visibility
 * identifiers are the canonical registry triple `private|organization|public`;
 * there is no execution engine in this module (WorkflowRun is V2-005's).
 */
export {
  WORKFLOW_VISIBILITIES,
  WORKFLOW_REPOSITORY_ERROR_CODES,
  WorkflowRepositoryError,
} from './types.js';
export type {
  WorkflowVisibility,
  WorkflowInstallationStatus,
  WorkflowInstallationAction,
  WorkflowVersionProtocolDescriptor,
  WorkflowPrincipal,
  Workflow,
  WorkflowVersion,
  WorkflowInstallation,
  WorkflowInstallationDetail,
  CreateWorkflowInput,
  UpdateWorkflowPatch,
  CreateVersionInput,
  ForkWorkflowInput,
  ForkInitialVersion,
  ForkWorkflowResult,
  InstallVersionInput,
  CreateWorkflowResult,
  CreateVersionResult,
  InstallVersionResult,
  OrganizationMembershipResolver,
  WorkflowRepositoryService,
  WorkflowRepositoryErrorCode,
} from './types.js';

export { DefaultWorkflowRepositoryService } from './internal/workflow-repository-service.js';
export type { DefaultWorkflowRepositoryServiceDeps } from './internal/workflow-repository-service.js';
