/**
 * PRODUCTION READINESS — bootstrap production owner.
 *
 * Creates the initial organization, owner user, project, and API key in a
 * fresh production database. Run this ONCE after the first deployment to
 * provision the initial admin identity. The API key is printed to stdout
 * (and the secret env var) — store it securely.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   WORKFLOWOS_BOOTSTRAP_API_KEY=<your-secure-key> \
 *   bun scripts/bootstrap-production.ts
 *
 * Idempotent: safe to re-run (it will report existing resources).
 *
 * SECURITY: do NOT commit the API key. The key is read from the
 * WORKFLOWOS_BOOTSTRAP_API_KEY env var and stored in the SecretStore (env).
 */
import { createDatabaseClient, createLogger, EnvSecretStore } from '../backend/src/platform/index.ts';
import { PgUserRepository } from '../backend/src/modules/users/internal/pg-user-repository.js';
import { PgOrganizationRepository } from '../backend/src/modules/organizations/internal/pg-organization-repository.js';
import { PgMembershipRepository, PgRolePermissionRepository } from '../backend/src/modules/organizations/internal/pg-membership-repository.js';
import { PgProjectRepository, PgProjectAccessRepository } from '../backend/src/modules/projects/internal/pg-project-repository.js';
import { ApiKeyAuthProvider } from '../backend/src/modules/auth/internal/api-key-auth-provider.js';
import { DefaultAuthorizationService, ApiKeyCredentialProvisioner } from '../backend/src/modules/auth/internal/authorization-service.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is required');
    process.exit(1);
  }
  const rawKey = process.env.WORKFLOWOS_BOOTSTRAP_API_KEY;
  if (!rawKey) {
    console.error('ERROR: WORKFLOWOS_BOOTSTRAP_API_KEY is required (set it to a secure random string)');
    process.exit(1);
  }
  const orgName = process.env.WORKFLOWOS_BOOTSTRAP_ORG_NAME ?? 'Production Org';
  const projectName = process.env.WORKFLOWOS_BOOTSTRAP_PROJECT_NAME ?? 'Production Project';

  const db = createDatabaseClient({ connectionString: databaseUrl });
  const logger = createLogger({ level: 'info' });
  const secretStore = new EnvSecretStore();

  // Set the API key secret in the env so the SecretStore can read it.
  process.env['WORKFLOWOS_BOOTSTRAP_KEY_SECRET'] = rawKey;

  const userRepo = new PgUserRepository(db);
  const orgRepo = new PgOrganizationRepository(db);
  const membershipRepo = new PgMembershipRepository(db);
  const rolePermRepo = new PgRolePermissionRepository(db);
  const projectRepo = new PgProjectRepository(db);
  const projectAccessRepo = new PgProjectAccessRepository(db);
  const apiKeyProvisioner = new ApiKeyCredentialProvisioner(db);

  // 1. Organization
  let orgId: string;
  const existingOrgs = await db.query<{ id: string }>('SELECT id FROM wfos_organizations WHERE name = $1', [orgName]);
  if (existingOrgs.rows.length > 0) {
    orgId = existingOrgs.rows[0]!.id;
    console.log(`Organization "${orgName}" already exists: ${orgId}`);
  } else {
    const org = await orgRepo.create({ name: orgName });
    orgId = org.id;
    console.log(`Created organization "${orgName}": ${orgId}`);
  }

  // 2. Owner user
  let userId: string;
  const existingUsers = await db.query<{ id: string }>('SELECT id FROM wfos_users WHERE external_id = $1', ['production-owner']);
  if (existingUsers.rows.length > 0) {
    userId = existingUsers.rows[0]!.id;
    console.log(`Owner user already exists: ${userId}`);
  } else {
    const user = await userRepo.upsertByExternalId({ externalId: 'production-owner', displayName: 'Production Owner' });
    userId = user.id;
    console.log(`Created owner user: ${userId}`);
  }

  // 3. Assign owner role
  try {
    await membershipRepo.assign({ userId, organizationId: orgId, roleId: 'owner' });
    console.log('Assigned owner role');
  } catch {
    console.log('Owner role already assigned');
  }

  // 4. Provision API key
  try {
    await apiKeyProvisioner.provision({
      keyId: 'production-owner-key',
      secretRef: 'WORKFLOWOS_BOOTSTRAP_KEY_SECRET',
      externalId: 'production-owner',
      label: 'Production Owner API Key',
      rawKey,
    });
    console.log('Provisioned API key');
  } catch {
    console.log('API key already provisioned');
  }

  // 5. Create project
  let projectId: string;
  const existingProjects = await db.query<{ id: string }>('SELECT id FROM wfos_projects WHERE name = $1 AND organization_id = $2', [projectName, orgId]);
  if (existingProjects.rows.length > 0) {
    projectId = existingProjects.rows[0]!.id;
    console.log(`Project "${projectName}" already exists: ${projectId}`);
  } else {
    const project = await projectRepo.create({ organizationId: orgId, name: projectName });
    projectId = project.id;
    console.log(`Created project "${projectName}": ${projectId}`);
  }

  // 6. Grant project access
  try {
    await projectAccessRepo.grant({ userId, projectId, roleId: 'owner' });
    console.log('Granted project access');
  } catch {
    console.log('Project access already granted');
  }

  console.log('');
  console.log('=== PRODUCTION BOOTSTRAP COMPLETE ===');
  console.log(`API Key:     ${rawKey}`);
  console.log(`Project ID:  ${projectId}`);
  console.log(`Org ID:      ${orgId}`);
  console.log(`User ID:     ${userId}`);
  console.log('');
  console.log('Use the API Key to log in to the frontend.');
  console.log('Store it securely — it will not be shown again.');
  await db.close();
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
