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
 * WORK-002: exposes ONLY the minimal project ownership/access contract
 * required for tenant isolation (AUTHZ-AC-01..03). Full project configuration,
 * repository associations, and lifecycle belong to WORK-004 (PROJ-001) and
 * are intentionally NOT implemented here.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Project,
  CreateProjectInput,
  ProjectAccess,
  GrantProjectAccessInput,
  ProjectRepository,
  ProjectAccessRepository,
} from './internal/project.types.js';
export {
  PgProjectRepository,
  PgProjectAccessRepository,
} from './internal/pg-project-repository.js';

/**
 * Public capabilities exposed by the /projects module to other modules.
 */
export interface ProjectsModuleApi {
  // future: WORK-004 will add project-domain methods
}

/**
 * Frozen module contract for /projects.
 */
export const projectsModule: ModuleContract & ProjectsModuleApi = {
  name: '/projects',
};

export default projectsModule;
