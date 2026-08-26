import type { DatabaseClient } from '@platform/index.js';
import { PgUserRepository } from '../../src/modules/users/internal/pg-user-repository.js';
import { PgOrganizationRepository } from '../../src/modules/organizations/internal/pg-organization-repository.js';
import { PgMembershipRepository, PgRolePermissionRepository } from '../../src/modules/organizations/internal/pg-membership-repository.js';
import { PgProjectRepository, PgProjectAccessRepository, PgProjectRepositoryAssociationRepository } from '../../src/modules/projects/internal/pg-project-repository.js';
import { PgSpecificationRepository, PgSpecificationVersionRepository } from '../../src/modules/specifications/internal/pg-specification-repository.js';
import {
  PgArchitectureRepository,
  PgArchitectureVersionRepository,
  PgArchitectureDecisionRepository,
  PgArchitectureChangeRequestRepository,
} from '../../src/modules/architecture/internal/pg-architecture-repository.js';
import { DefaultArchitectureService } from '../../src/modules/architecture/internal/architecture-service.js';
import {
  PgRequirementRepository,
  PgRequirementDependencyRepository,
  PgAcceptanceCriterionRepository,
  PgEvidenceReferenceRepository,
} from '../../src/modules/requirements/internal/pg-requirement-repository.js';
import {
  PgWorkItemRepository,
  PgWorkItemRequirementRepository,
  PgWorkItemCriterionRepository,
  PgWorkItemDependencyRepository,
  PgPullRequestAssociationRepository,
  PgWorkOrderRepository,
  DefaultWorkItemCompletionService,
} from '../../src/modules/work-items/internal/pg-work-item-repository.js';
import { ApiKeyAuthProvider } from '../../src/modules/auth/internal/api-key-auth-provider.js';
import { DefaultAuthorizationService, ApiKeyCredentialProvisioner } from '../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryObjectStore } from '@platform/index.js';
import { buildTestDatabase, type TestDatabase } from './test-database.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { PgProjectBaselineRepository } from '../../src/modules/projects/internal/pg-project-baseline-repository.js';

/**
 * Test harness wiring the WORK-002 + WORK-004 identity/authorization/project/
 * specification stack on top of a real PostgreSQL (pglite locally / real pg in
 * CI). Used by the auth + project + specification integration tests.
 */
export interface TestAuthStack {
  db: TestDatabase;
  userRepository: PgUserRepository;
  organizationRepository: PgOrganizationRepository;
  membershipRepository: PgMembershipRepository;
  rolePermissionRepository: PgRolePermissionRepository;
  projectRepository: PgProjectRepository;
  projectAccessRepository: PgProjectAccessRepository;
  repositoryAssociationRepository: PgProjectRepositoryAssociationRepository;
  specificationRepository: PgSpecificationRepository;
  specificationVersionRepository: PgSpecificationVersionRepository;
  architectureRepository: PgArchitectureRepository;
  architectureVersionRepository: PgArchitectureVersionRepository;
  architectureDecisionRepository: PgArchitectureDecisionRepository;
  architectureChangeRequestRepository: PgArchitectureChangeRequestRepository;
  architectureService: DefaultArchitectureService;
  requirementRepository: PgRequirementRepository;
  requirementDependencyRepository: PgRequirementDependencyRepository;
  acceptanceCriterionRepository: PgAcceptanceCriterionRepository;
  evidenceReferenceRepository: PgEvidenceReferenceRepository;
  workItemRepository: PgWorkItemRepository;
  workItemRequirementRepository: PgWorkItemRequirementRepository;
  workItemCriterionRepository: PgWorkItemCriterionRepository;
  workItemDependencyRepository: PgWorkItemDependencyRepository;
  pullRequestAssociationRepository: PgPullRequestAssociationRepository;
  workOrderRepository: PgWorkOrderRepository;
  /** INTERNAL completion service — not in the /work-items public barrel. */
  workItemCompletionService: DefaultWorkItemCompletionService;
  /** WORK-015/WORK-041: the CI evidence ingestion repository (real PG). */
  ciEvidenceRepository: PgCiEvidenceIngestionRepository;
  /** WORK-038/WORK-041: the project baseline repository (real PG). */
  projectBaselineRepository: PgProjectBaselineRepository;
  authProvider: ApiKeyAuthProvider;
  authorizationService: DefaultAuthorizationService;
  apiKeyProvisioner: ApiKeyCredentialProvisioner;
  secretStore: EnvSecretStore;
  objectStore: InMemoryObjectStore;
  teardown: () => Promise<void>;
}

/**
 * Build the auth + project + specification stack. The caller owns the
 * lifecycle; call `teardown()` to close the database.
 *
 * @param setEnvSecrets optional map of env vars to set before constructing
 *   the EnvSecretStore (used to place raw API keys in the secret store).
 */
export async function buildAuthStack(setEnvSecrets: Record<string, string> = {}): Promise<TestAuthStack> {
  for (const [k, v] of Object.entries(setEnvSecrets)) {
    process.env[k] = v;
  }
  const db = await buildTestDatabase();
  const secretStore = new EnvSecretStore();
  const objectStore = new InMemoryObjectStore();
  const userRepository = new PgUserRepository(db.client);
  const membershipRepository = new PgMembershipRepository(db.client);
  const rolePermissionRepository = new PgRolePermissionRepository(db.client);
  const organizationRepository = new PgOrganizationRepository(db.client);
  const projectRepository = new PgProjectRepository(db.client);
  const projectAccessRepository = new PgProjectAccessRepository(db.client);
  const repositoryAssociationRepository = new PgProjectRepositoryAssociationRepository(db.client);
  const specificationRepository = new PgSpecificationRepository(db.client);
  const specificationVersionRepository = new PgSpecificationVersionRepository(db.client);
  const architectureRepository = new PgArchitectureRepository(db.client);
  const architectureVersionRepository = new PgArchitectureVersionRepository(db.client);
  const architectureDecisionRepository = new PgArchitectureDecisionRepository(db.client);
  const architectureChangeRequestRepository = new PgArchitectureChangeRequestRepository(db.client);
  const architectureService = new DefaultArchitectureService(db.client);
  const requirementRepository = new PgRequirementRepository(db.client);
  const requirementDependencyRepository = new PgRequirementDependencyRepository(db.client);
  const acceptanceCriterionRepository = new PgAcceptanceCriterionRepository(db.client);
  const evidenceReferenceRepository = new PgEvidenceReferenceRepository(db.client);
  const workItemRepository = new PgWorkItemRepository(db.client);
  const workItemRequirementRepository = new PgWorkItemRequirementRepository(db.client);
  const workItemCriterionRepository = new PgWorkItemCriterionRepository(db.client);
  const workItemDependencyRepository = new PgWorkItemDependencyRepository(db.client);
  const pullRequestAssociationRepository = new PgPullRequestAssociationRepository(db.client);
  const workOrderRepository = new PgWorkOrderRepository(db.client);
  const workItemCompletionService = new DefaultWorkItemCompletionService(workItemRepository);
  const ciEvidenceRepository = new PgCiEvidenceIngestionRepository(db.client);
  const projectBaselineRepository = new PgProjectBaselineRepository(db.client);
  const authProvider = new ApiKeyAuthProvider(db.client, secretStore);
  const authorizationService = new DefaultAuthorizationService(
    membershipRepository,
    rolePermissionRepository,
    projectRepository,
    projectAccessRepository,
  );
  const apiKeyProvisioner = new ApiKeyCredentialProvisioner(db.client);

  const teardown = async () => {
    await db.close();
    for (const k of Object.keys(setEnvSecrets)) {
      delete process.env[k];
    }
  };

  return {
    db,
    userRepository,
    organizationRepository,
    membershipRepository,
    rolePermissionRepository,
    projectRepository,
    projectAccessRepository,
    repositoryAssociationRepository,
    specificationRepository,
    specificationVersionRepository,
    architectureRepository,
    architectureVersionRepository,
    architectureDecisionRepository,
    architectureChangeRequestRepository,
    architectureService,
    requirementRepository,
    requirementDependencyRepository,
    acceptanceCriterionRepository,
    evidenceReferenceRepository,
    workItemRepository,
    workItemRequirementRepository,
    workItemCriterionRepository,
    workItemDependencyRepository,
    pullRequestAssociationRepository,
    workOrderRepository,
    workItemCompletionService,
    ciEvidenceRepository,
    projectBaselineRepository,
    authProvider,
    authorizationService,
    apiKeyProvisioner,
    secretStore,
    objectStore,
    teardown,
  };
}

export type { DatabaseClient };
