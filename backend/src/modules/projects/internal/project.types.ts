/**
 * Authoritative project domain types (PROJ-001, PROJ-AC-01..03).
 *
 * WORK-004 evolves the WORK-002 minimal project representation into the
 * authoritative project domain. The `Project` interface gains lifecycle
 * state, metadata, and timestamps. The existing `ProjectAccess` / project
 * access relationships from WORK-002 are preserved unchanged.
 */

/** Explicit project lifecycle state (PROJ-AC-03). */
export type ProjectState = 'active' | 'archived';

/** Authoritative project record. Evolved from the WORK-002 minimal shape. */
export interface Project {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly state: ProjectState;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectInput {
  name?: string;
  metadata?: Record<string, unknown>;
}

/** Result of a lifecycle transition. */
export interface ProjectLifecycleTransition {
  readonly projectId: string;
  readonly from: ProjectState;
  readonly to: ProjectState;
}

/**
 * Provider-independent repository association (PROJ-AC-02). Stores only a
 * reference to an external repository; the actual GitHub adapter is WORK-008.
 */
export interface ProjectRepositoryAssociation {
  readonly id: string;
  readonly projectId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly canonicalRef: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface AssociateRepositoryInput {
  projectId: string;
  provider: string;
  externalId: string;
  canonicalRef: string;
  metadata?: Record<string, unknown>;
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
 * Project repository contract. Evolved from the WORK-002 minimal shape to
 * include lifecycle transitions + metadata.
 */
export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  update(id: string, input: UpdateProjectInput): Promise<Project | null>;
  /** Transition a project's lifecycle state. Validates the transition. */
  transitionState(id: string, to: ProjectState): Promise<ProjectLifecycleTransition>;
  listForOrganization(organizationId: string): Promise<Project[]>;
}

/**
 * Repository for project-scoped access grants (AUTHZ-AC-01..03).
 * Preserved from WORK-002.
 */
export interface ProjectAccessRepository {
  grant(input: GrantProjectAccessInput): Promise<ProjectAccess>;
  findByUserAndProject(userId: string, projectId: string): Promise<ProjectAccess | null>;
  listForUser(userId: string): Promise<ProjectAccess[]>;
}

/**
 * Repository for provider-independent project↔repository associations.
 */
export interface ProjectRepositoryAssociationRepository {
  associate(input: AssociateRepositoryInput): Promise<ProjectRepositoryAssociation>;
  listForProject(projectId: string): Promise<ProjectRepositoryAssociation[]>;
  findById(id: string): Promise<ProjectRepositoryAssociation | null>;
  remove(id: string): Promise<void>;
}
