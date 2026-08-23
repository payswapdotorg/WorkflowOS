/**
 * WORK-026: Default {@link DeploymentService} — the provider-independent
 * facade over the registered {@link DeploymentProvider} adapters.
 *
 * Responsibilities:
 *   - Maintain a name → provider registry (`registerProvider` / `getProvider`
 *     / `listProviders`).
 *   - Provision a project under a provider: call the provider's `createProject`
 *     (or `linkRepository`), then persist a new `wfos_runtime_integrations`
 *     row via {@link RuntimeIntegrationRepository}.
 *   - Record per-commit deployments: look up the integration by
 *     (projectId, provider), throw if not provisioned, else create a
 *     `wfos_deployments` row via {@link DeploymentRepository}.
 *   - Resolve the latest deployment for a project (delegated to the
 *     deployment repository's join query).
 *
 * The service NEVER makes provider HTTP calls directly — those live in the
 * injected adapters. Secrets never reach this layer. Workflow state is never
 * mutated (WORK-026 Decision F: /runtime owns deployment/preview only).
 *
 * This file is private to /runtime (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  Deployment,
  DeploymentRepository,
  DeploymentService,
  DeploymentProvider,
  DeploymentStatus,
  LinkRepositoryInput,
  RuntimeIntegration,
  RuntimeIntegrationRepository,
} from './runtime.types.js';

export class DefaultDeploymentService implements DeploymentService {
  private readonly providers = new Map<string, DeploymentProvider>();

  constructor(
    private readonly runtimeIntegrationRepository: RuntimeIntegrationRepository,
    private readonly deploymentRepository: DeploymentRepository,
    private readonly logger: Logger,
  ) {}

  registerProvider(provider: DeploymentProvider): void {
    this.providers.set(provider.name, provider);
    this.logger.info('runtime.deployment-service.provider-registered', {
      provider: provider.name,
    });
  }

  getProvider(name: string): DeploymentProvider | null {
    return this.providers.get(name) ?? null;
  }

  listProviders(): DeploymentProvider[] {
    return Array.from(this.providers.values());
  }

  async provisionProject(input: {
    projectId: string;
    provider: string;
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<RuntimeIntegration> {
    const provider = this.requireProvider(input.provider);
    const created = await provider.createProject({
      projectId: input.projectId,
      name: input.name,
      metadata: input.metadata,
    });
    this.logger.info('runtime.deployment-service.project-provisioned', {
      projectId: input.projectId,
      provider: input.provider,
      projectExternalId: created.projectExternalId,
    });
    return this.runtimeIntegrationRepository.create({
      projectId: input.projectId,
      provider: input.provider,
      projectExternalId: created.projectExternalId,
      metadata: created.metadata,
    });
  }

  async linkRepository(input: LinkRepositoryInput): Promise<RuntimeIntegration> {
    const provider = this.requireProvider(input.provider);
    const linked = await provider.linkRepository(input);
    this.logger.info('runtime.deployment-service.repository-linked', {
      projectId: input.projectId,
      provider: input.provider,
      projectExternalId: linked.projectExternalId,
      repositoryRef: input.repositoryRef,
    });
    return this.runtimeIntegrationRepository.create({
      projectId: input.projectId,
      provider: input.provider,
      projectExternalId: linked.projectExternalId,
      metadata: linked.metadata,
    });
  }

  async recordDeployment(input: {
    projectId: string;
    provider: string;
    externalId: string;
    status: DeploymentStatus;
    previewUrl?: string;
    commitSha?: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Deployment> {
    const integration = await this.runtimeIntegrationRepository.findByProjectAndProvider(
      input.projectId,
      input.provider,
    );
    if (!integration) {
      throw new Error(
        `runtime-integration-not-found: project=${input.projectId} provider=${input.provider}`,
      );
    }
    const deployment = await this.deploymentRepository.create({
      integrationId: integration.id,
      externalId: input.externalId,
      status: input.status,
      previewUrl: input.previewUrl,
      commitSha: input.commitSha,
      branch: input.branch,
      metadata: input.metadata,
    });
    this.logger.info('runtime.deployment-service.deployment-recorded', {
      projectId: input.projectId,
      provider: input.provider,
      integrationId: integration.id,
      deploymentId: deployment.id,
      externalId: deployment.externalId,
      status: deployment.status,
    });
    return deployment;
  }

  async getLatestDeployment(projectId: string): Promise<Deployment | null> {
    return this.deploymentRepository.findLatestForProject(projectId);
  }

  // -------------------------------------------------------------------

  private requireProvider(name: string): DeploymentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`provider-not-registered: ${name}`);
    }
    return provider;
  }
}
