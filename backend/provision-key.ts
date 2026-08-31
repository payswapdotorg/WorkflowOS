/**
 * DEVELOPMENT-ONLY bootstrap key provisioner.
 *
 * WORK-074 / WORK-063 invariant #9: the demo key is RETIRED from the
 * customer-facing production login path. This script exists ONLY to seed a
 * local development database with a demo API key for automation experiments
 * (run it explicitly with `bun run provision-key.ts`; nothing in the runtime,
 * the login surface, or CI depends on it). The customer login path is the
 * human login (Google / GitHub / email) served by the /auth identity routes.
 *
 * Never run against a production database.
 */
import { createDatabaseClient, createLogger, EnvSecretStore } from './src/platform/index.ts';
import { PgUserRepository } from './src/modules/users/internal/pg-user-repository.js';
import { PgOrganizationRepository } from './src/modules/organizations/internal/pg-organization-repository.js';
import { PgMembershipRepository, PgRolePermissionRepository } from './src/modules/organizations/internal/pg-membership-repository.js';
import { PgProjectRepository, PgProjectAccessRepository } from './src/modules/projects/internal/pg-project-repository.js';
import { ApiKeyAuthProvider } from './src/modules/auth/internal/api-key-auth-provider.js';
import { DefaultAuthorizationService, ApiKeyCredentialProvisioner } from './src/modules/auth/internal/authorization-service.js';

const db = createDatabaseClient({ connectionString: process.env.DATABASE_URL! });
const secretStore = new EnvSecretStore();
const RAW_KEY = 'wfos-demo-vertex-2026';
process.env['WFOS_DEMO_KEY_SECRET'] = RAW_KEY;

const userRepo = new PgUserRepository(db);
const orgRepo = new PgOrganizationRepository(db);
const membershipRepo = new PgMembershipRepository(db);
const rolePermRepo = new PgRolePermissionRepository(db);
const projectRepo = new PgProjectRepository(db);
const projectAccessRepo = new PgProjectAccessRepository(db);
const apiKeyProvisioner = new ApiKeyCredentialProvisioner(db);

async function main() {
  let orgId: string;
  const existingOrgs = await db.query<{ id: string }>('SELECT id FROM wfos_organizations WHERE name = $1', ['Demo Org']);
  if (existingOrgs.rows.length > 0) { orgId = existingOrgs.rows[0]!.id; console.log('Demo Org exists:', orgId); }
  else { const org = await orgRepo.create({ name: 'Demo Org' }); orgId = org.id; console.log('Created Demo Org:', orgId); }

  let userId: string;
  const existingUsers = await db.query<{ id: string }>('SELECT id FROM wfos_users WHERE external_id = $1', ['demo-user']);
  if (existingUsers.rows.length > 0) { userId = existingUsers.rows[0]!.id; console.log('Demo User exists:', userId); }
  else { const user = await userRepo.upsertByExternalId({ externalId: 'demo-user', displayName: 'Demo User' }); userId = user.id; console.log('Created Demo User:', userId); }

  try { await membershipRepo.assign({ userId, organizationId: orgId, roleId: 'owner' }); console.log('Assigned owner role'); }
  catch (err) { console.log('Role already assigned'); }

  try {
    await apiKeyProvisioner.provision({ keyId: 'demo-key', secretRef: 'WFOS_DEMO_KEY_SECRET', externalId: 'demo-user', label: 'Demo API Key', rawKey: RAW_KEY });
    console.log('Provisioned API key');
  } catch (err) { console.log('API key already provisioned'); }

  let projectId: string;
  const existingProjects = await db.query<{ id: string }>('SELECT id FROM wfos_projects WHERE name = $1 AND organization_id = $2', ['Demo Project', orgId]);
  if (existingProjects.rows.length > 0) { projectId = existingProjects.rows[0]!.id; console.log('Demo Project exists:', projectId); }
  else { const project = await projectRepo.create({ organizationId: orgId, name: 'Demo Project' }); projectId = project.id; console.log('Created Demo Project:', projectId); }

  try { await projectAccessRepo.grant({ userId, projectId, roleId: 'owner' }); console.log('Granted project access'); }
  catch (err) { console.log('Project access already granted'); }

  console.log('');
  console.log('=== LOGIN CREDENTIALS ===');
  console.log('API Key:', RAW_KEY);
  console.log('Project ID:', projectId);
  console.log('');
  process.exit(0);
}
main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
