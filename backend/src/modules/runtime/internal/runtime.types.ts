/**
 * WORK-026: /runtime module types.
 *
 * Provider-independent deployment / preview environment boundary.
 * The /runtime module owns the integration link between a WorkflowOS
 * project and an external deployment provider (Vercel, fake, future), plus
 * the per-commit deployment records.
 *
 * Concrete provider adapters (Vercel, fake) live in internal/ and are
 * injected by the composition root. Secrets never cross this boundary.
 */

export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

/** A project ↔ deployment-provider integration link (one row per (project, provider)). */
export interface RuntimeIntegration {
  readonly id: string;
  readonly projectId: string;
  readonly provider: string;            // 'vercel' | 'fake' | ...
  readonly projectExternalId: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A per-commit deployment record produced by a deployment provider. */
export interface Deployment {
  readonly id: string;
  readonly integrationId: string;
  readonly externalId: string;
  readonly status: DeploymentStatus;
  readonly previewUrl: string | null;
  readonly commitSha: string | null;
  readonly branch: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProjectDeploymentInput {
  projectId: string;
  provider: string;
  projectExternalId: string;
  metadata?: Record<string, unknown>;
}

export interface LinkRepositoryInput {
  projectId: string;
  provider: string;
  repositoryRef: string;            // e.g. 'owner/repo' on GitHub
  branch?: string;
  metadata?: Record<string, unknown>;
}

export interface GetDeploymentInput {
  projectId: string;
  commitSha?: string;
  branch?: string;
}

/**
 * Provider-independent deployment provider adapter. Concrete impls:
 * VercelDeploymentProvider (uses fetch against Vercel API), FakeDeploymentProvider
 * (deterministic for CI/tests). The composition root injects the active set.
 */
export interface DeploymentProvider {
  readonly name: string;                                          // 'vercel' | 'fake'
  createProject(input: { projectId: string; name: string; metadata?: Record<string, unknown> }): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }>;
  linkRepository(input: LinkRepositoryInput): Promise<{ projectExternalId: string; metadata: Record<string, unknown> }>;
  getDeployment(input: GetDeploymentInput): Promise<Deployment | null>;
  getPreviewUrl(input: { projectId: string; commitSha?: string; branch?: string }): Promise<string | null>;
  getDeploymentStatus(input: GetDeploymentInput): Promise<DeploymentStatus | null>;
  /** 'connected' | 'not-configured' | 'error' | 'test-mode' */
  health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'>;
}

/** Repository for RuntimeIntegration rows (wfos_runtime_integrations). */
export interface RuntimeIntegrationRepository {
  create(input: CreateProjectDeploymentInput): Promise<RuntimeIntegration>;
  findByProject(projectId: string): Promise<RuntimeIntegration[]>;
  findByProjectAndProvider(projectId: string, provider: string): Promise<RuntimeIntegration | null>;
  findById(id: string): Promise<RuntimeIntegration | null>;
  update(id: string, patch: { projectExternalId?: string; metadata?: Record<string, unknown> }): Promise<RuntimeIntegration | null>;
  remove(id: string): Promise<void>;
}

/** Repository for Deployment rows (wfos_deployments). */
export interface DeploymentRepository {
  create(input: { integrationId: string; externalId: string; status: DeploymentStatus; previewUrl?: string; commitSha?: string; branch?: string; metadata?: Record<string, unknown> }): Promise<Deployment>;
  findByIntegration(integrationId: string): Promise<Deployment[]>;
  findLatestForProject(projectId: string): Promise<Deployment | null>;
  findById(id: string): Promise<Deployment | null>;
  updateStatus(id: string, status: DeploymentStatus, patch?: { previewUrl?: string; commitSha?: string; metadata?: Record<string, unknown> }): Promise<Deployment | null>;
}

/** Provider-independent facade over the registered DeploymentProvider adapters. */
export interface DeploymentService {
  registerProvider(provider: DeploymentProvider): void;
  getProvider(name: string): DeploymentProvider | null;
  listProviders(): DeploymentProvider[];
  provisionProject(input: { projectId: string; provider: string; name: string; metadata?: Record<string, unknown> }): Promise<RuntimeIntegration>;
  linkRepository(input: LinkRepositoryInput): Promise<RuntimeIntegration>;
  recordDeployment(input: { projectId: string; provider: string; externalId: string; status: DeploymentStatus; previewUrl?: string; commitSha?: string; branch?: string; metadata?: Record<string, unknown> }): Promise<Deployment>;
  getLatestDeployment(projectId: string): Promise<Deployment | null>;
}

/** Aggregated runtime status for a project (consumed by the project overview UI). */
export interface ProjectRuntimeStatus {
  readonly github: { status: 'connected' | 'not-configured' | 'error' | 'test-mode'; owner?: string; repository?: string; defaultBranch?: string | null };
  readonly vercel:  { status: 'connected' | 'not-configured' | 'error' | 'test-mode'; projectId?: string; previewUrl?: string | null; latestDeployment?: Deployment | null };
  readonly architect: { status: 'connected' | 'not-configured' | 'test-mode'; providers: Array<{ name: string; provider: string; model: string; status: 'ready' | 'not-configured' }> };
  readonly agent: { status: 'connected' | 'not-configured' | 'test-mode'; providers: Array<{ name: string; provider: string; model: string; status: 'ready' | 'not-configured' }> };
}

/** Aggregates GitHub + Vercel + Architect + Agent status for a project. */
export interface RuntimeStatusService {
  getStatus(projectId: string): Promise<ProjectRuntimeStatus>;
}
