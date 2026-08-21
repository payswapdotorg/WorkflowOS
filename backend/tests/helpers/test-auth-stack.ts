import type { DatabaseClient } from '@platform/postgres/database-client.js';
import { PgUserRepository } from '@modules/users/index.js';
import { PgOrganizationRepository, PgMembershipRepository, PgRolePermissionRepository } from '@modules/organizations/index.js';
import { PgProjectRepository, PgProjectAccessRepository } from '@modules/projects/index.js';
import {
  ApiKeyAuthProvider,
  DefaultAuthorizationService,
  ApiKeyCredentialProvisioner,
} from '@modules/auth/index.js';
import { EnvSecretStore } from '@platform/index.js';
import { buildTestDatabase, type TestDatabase } from './test-database.js';

/**
 * Test harness wiring the WORK-002 identity + authorization stack on top of
 * a real PostgreSQL (pglite locally / real pg in CI). Used by the auth
 * integration tests.
 */
export interface TestAuthStack {
  db: TestDatabase;
  userRepository: PgUserRepository;
  organizationRepository: PgOrganizationRepository;
  membershipRepository: PgMembershipRepository;
  rolePermissionRepository: PgRolePermissionRepository;
  projectRepository: PgProjectRepository;
  projectAccessRepository: PgProjectAccessRepository;
  authProvider: ApiKeyAuthProvider;
  authorizationService: DefaultAuthorizationService;
  apiKeyProvisioner: ApiKeyCredentialProvisioner;
  secretStore: EnvSecretStore;
  teardown: () => Promise<void>;
}

/**
 * Build the WORK-002 auth stack. The caller owns the lifecycle; call
 * `teardown()` to close the database.
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
  const userRepository = new PgUserRepository(db.client);
  const membershipRepository = new PgMembershipRepository(db.client);
  const rolePermissionRepository = new PgRolePermissionRepository(db.client);
  const organizationRepository = new PgOrganizationRepository(db.client);
  const projectRepository = new PgProjectRepository(db.client);
  const projectAccessRepository = new PgProjectAccessRepository(db.client);
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
    authProvider,
    authorizationService,
    apiKeyProvisioner,
    secretStore,
    teardown,
  };
}

export type { DatabaseClient };
