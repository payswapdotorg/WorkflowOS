/**
 * Minimal project-domain types (AUTHZ-AC-01..03).
 *
 * WORK-002 is NOT a project-domain implementation task. Only the minimal
 * project ownership/access relationship required to establish the
 * authorization contract is introduced here. Full project configuration,
 * repository associations, and lifecycle belong to WORK-004 (PROJ-001).
 */

/** Minimal project record: id + owning organization + name. */
export interface Project {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
}

/** A user's role on a specific project (drives project-scoped authorization). */
export interface ProjectAccess {
  readonly id: string;
  readonly userId: string;
  readonly projectId: string;
  readonly roleId: string;
  readonly createdAt: Date;
}

export interface GrantProjectAccessInput {
  userId: string;
  projectId: string;
  roleId: string;
}

/**
 * Minimal project repository. Only what WORK-002 needs to demonstrate
 * tenant isolation; WORK-004 will expand the project domain.
 */
export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
}

/**
 * Repository for project-scoped access grants (AUTHZ-AC-01..03).
 */
export interface ProjectAccessRepository {
  grant(input: GrantProjectAccessInput): Promise<ProjectAccess>;
  findByUserAndProject(userId: string, projectId: string): Promise<ProjectAccess | null>;
  listForUser(userId: string): Promise<ProjectAccess[]>;
}
