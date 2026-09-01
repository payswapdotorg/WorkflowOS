/**
 * V2-002 — REQUIRED REAL-SYSTEM DOGFOODING EXPERIMENT (dogfooding-protocol.md).
 *
 * Runs the Work Order's required experiment through the REAL product path:
 *
 *   real PGlite (actual PostgreSQL compiled to WASM — the platform's
 *   pglite-database-client, the same single persistence boundary as
 *   production `pg`) → real migration-runner (all migrations incl. 0060) →
 *   real identity stack (users / organizations / memberships / API-key
 *   auth provider) → REAL Fastify app built by buildServer with the REAL
 *   workflow-repository route registered through api/server.ts → every step
 *   driven over HTTP via app.inject().
 *
 * Experiment (V2-002 work order "Dogfooding"):
 *   create a real workflow → edit it (new immutable version) → install/pin
 *   BOTH versions → fork it (cross-tenant) → verify the old installation
 *   stays pinned, provenance is preserved, private state never transfers,
 *   and no cross-tenant leak exists; plus the R6 raw-SQL tamper attempts
 *   against the real database boundary.
 *
 * Honest scope observation (recorded, NOT a failure): WorkflowRun execution
 * is owned by V2-005 and does not exist yet — installations are PINNED but
 * never EXECUTED here.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/workflow-repository/workflow-repository.dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = a failure to triage.
 */
import { createPgliteDatabaseClient } from '@platform/postgres/pglite-database-client.js';
import { runMigrations } from '@platform/postgres/migration-runner.js';
import { createLogger } from '@platform/logger.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { buildServer } from '@api/server.js';
import { PgUserRepository } from '../../../src/modules/users/internal/pg-user-repository.js';
import { PgOrganizationRepository } from '../../../src/modules/organizations/internal/pg-organization-repository.js';
import { PgMembershipRepository } from '../../../src/modules/organizations/internal/pg-membership-repository.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import { computeContentDigest } from '../../../src/workflow-repository/internal/identity.js';
import type { FastifyInstance } from 'fastify';

// --- the workflow under test (opaque content — V2-003 owns semantics) --------

const PROTOCOL = { irSchemaVersion: 'dogfood-ir-1' } as const;

const CONTENT_V1 = {
  title: 'On-call triage',
  steps: [
    { id: 's1', action: 'observe alert queue' },
    { id: 's2', action: 'classify severity' },
  ],
} as const;

const CONTENT_V2 = {
  title: 'On-call triage',
  steps: [
    { id: 's1', action: 'observe alert queue' },
    { id: 's2', action: 'classify severity' },
    { id: 's3', action: 'page the on-call human' },
  ],
} as const;

const CONTENT_V3 = { title: 'On-call triage v3', steps: [{ id: 's1', action: 'observe alert queue' }] } as const;
const CONTENT_V4 = { title: 'On-call triage v4', steps: [{ id: 's1', action: 'observe alert queue' }] } as const;

const KEY_A = 'v2-002-dogfood-key-a';
const KEY_B = 'v2-002-dogfood-key-b';

interface WorkflowPayload {
  id: string;
  organizationId: string;
  ownerUserId: string;
  slug: string;
  visibility: string;
  headVersionId: string | null;
  forkedFromWorkflowId: string | null;
  forkedFromVersionId: string | null;
  updatedAt: string;
}
interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
  parentVersionId: string | null;
}
interface InstallationPayload {
  id: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
  status: string;
}
interface InstallationDetailPayload {
  installation: InstallationPayload;
  pinnedVersion: { id: string; versionNumber: number; contentDigest: string };
}

// --- experiment harness -------------------------------------------------------

let failures = 0;

function step(name: string, held: boolean, detail: string): void {
  const mark = held ? 'PASS' : 'FAIL';
  if (!held) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${name} :: ${detail}`);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runId = `dogfood-${startedAt.toString(36)}`;

  // --- real infrastructure: PGlite + migrations --------------------------------

  const db = await createPgliteDatabaseClient();
  const logger = createLogger({ level: 'info' });
  const applied = await runMigrations(db, logger);
  step(
    'infra.migrations',
    applied.includes('0060_workflow_repository_v2.sql'),
    `real PGlite + migration-runner applied ${applied.length} migrations (0060 present: ${applied.includes('0060_workflow_repository_v2.sql')})`,
  );

  // --- real identity stack -----------------------------------------------------

  const userRepository = new PgUserRepository(db);
  const organizationRepository = new PgOrganizationRepository(db);
  const membershipRepository = new PgMembershipRepository(db);
  process.env['WFOS_DOGFOOD_KEY_A'] = KEY_A;
  process.env['WFOS_DOGFOOD_KEY_B'] = KEY_B;
  const authProvider = new ApiKeyAuthProvider(db, new EnvSecretStore());
  const provisioner = new ApiKeyCredentialProvisioner(db);

  const orgA = await organizationRepository.create({ name: 'V2-002 Dogfood Org A (publisher)' });
  const orgB = await organizationRepository.create({ name: 'V2-002 Dogfood Org B (customer/forker)' });
  const ownerA = await userRepository.upsertByExternalId({ externalId: 'v2-002-dogfood-owner-a', displayName: 'Dogfood Owner A' });
  const userB = await userRepository.upsertByExternalId({ externalId: 'v2-002-dogfood-user-b', displayName: 'Dogfood User B' });
  await membershipRepository.assign({ userId: ownerA.id, organizationId: orgA.id, roleId: 'owner' });
  await membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  await provisioner.provision({ keyId: 'v2-002-dogfood-key-a', secretRef: 'WFOS_DOGFOOD_KEY_A', externalId: 'v2-002-dogfood-owner-a', label: 'Dogfood A', rawKey: KEY_A });
  await provisioner.provision({ keyId: 'v2-002-dogfood-key-b', secretRef: 'WFOS_DOGFOOD_KEY_B', externalId: 'v2-002-dogfood-user-b', label: 'Dogfood B', rawKey: KEY_B });

  // --- the REAL application (route registered through api/server.ts) -----------

  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const service = new DefaultWorkflowRepositoryService({ db, memberships });
  const app: FastifyInstance = await buildServer({
    queue: new InMemoryQueue(),
    logger,
    auth: { authProvider, userRepository },
    workflowRepository: { workflowRepositoryService: service },
  });
  await app.ready();

  const inject = async (method: string, url: string, key: string | null, payload?: unknown) => {
    const headers: Record<string, string> = {};
    if (key) headers['x-api-key'] = key;
    return app.inject({
      method: method as never,
      url,
      headers,
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });
  };

  // === STEP 1 — create a real workflow (born with immutable version 1) =========

  const createRes = await inject('POST', `/organizations/${orgA.id}/workflow-repository/workflows`, KEY_A, {
    slug: 'on-call-triage',
    name: 'On-call Triage',
    description: 'Triage the alert queue and escalate',
    visibility: 'private',
    content: CONTENT_V1,
    protocol: PROTOCOL,
  });
  const created = createRes.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload; created: boolean };
  step('1.create-workflow', createRes.statusCode === 201 && created.created === true && created.initialVersion.versionNumber === 1,
    `POST 201 — workflow ${created.workflow.id} born with v1 ${created.initialVersion.id} (number 1, head=${created.workflow.headVersionId === created.initialVersion.id})`);

  const workflow = created.workflow;
  const v1 = created.initialVersion;
  const digestV1 = computeContentDigest(CONTENT_V1);
  step('1.content-digest', v1.contentDigest === digestV1,
    `v1 CONTENT digest = ${v1.contentDigest} (matches the pure derivation over canonical JSON)`);

  // === STEP 2 — read v1 (snapshot before the edit) ==============================

  const v1Read = await inject('GET', `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`, KEY_A);
  const v1BodyBefore: string = v1Read.body;
  step('2.read-v1', v1Read.statusCode === 200, `GET v1 → 200 (${v1BodyBefore.length} bytes)`);

  // === STEP 3 — edit: a NEW immutable version ====================================

  const editRes = await inject('POST', `/workflow-repository/workflows/${workflow.id}/versions`, KEY_A, {
    content: CONTENT_V2,
    protocol: PROTOCOL,
  });
  const edit = editRes.json() as { version: VersionPayload; created: boolean };
  const v2 = edit.version;
  step('3.edit-new-version', editRes.statusCode === 201 && edit.created === true && v2.versionNumber === 2 && v2.parentVersionId === v1.id,
    `POST versions 201 — v2 ${v2.id} (number 2, parent v1, digest ${v2.contentDigest})`);

  // === STEP 4 — R1: the old version is byte-identical after the edit =============

  const v1ReadAfter = await inject('GET', `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`, KEY_A);
  step('4.R1-old-version-immutable', v1ReadAfter.statusCode === 200 && v1ReadAfter.body === v1BodyBefore,
    `GET v1 after edit → 200, response body BYTE-IDENTICAL to the pre-edit snapshot`);

  // === STEP 5 — install/pin BOTH versions ========================================

  const installV1Res = await inject('POST', `/organizations/${orgA.id}/workflow-repository/installations`, KEY_A, {
    workflowId: workflow.id,
    versionId: v1.id,
  });
  const installV1 = installV1Res.json() as { installation: InstallationPayload; created: boolean };
  const instV1 = installV1.installation;
  step('5.install-v1', installV1Res.statusCode === 201 && installV1.created === true && instV1.versionId === v1.id && instV1.status === 'enabled',
    `POST installations 201 — installation ${instV1.id} PINS v1 (status enabled)`);

  const installV2Res = await inject('POST', `/organizations/${orgA.id}/workflow-repository/installations`, KEY_A, {
    workflowId: workflow.id,
    versionId: v2.id,
  });
  const installV2 = installV2Res.json() as { installation: InstallationPayload; created: boolean };
  step('5.install-v2', installV2Res.statusCode === 201 && installV2.created === true && installV2.installation.versionId === v2.id,
    `POST installations 201 — installation ${installV2.installation.id} PINS v2`);

  // === STEP 6 — a NEWER version exists (v3) ======================================

  const edit2Res = await inject('POST', `/workflow-repository/workflows/${workflow.id}/versions`, KEY_A, {
    content: CONTENT_V3,
    protocol: PROTOCOL,
  });
  const v3 = (edit2Res.json() as { version: VersionPayload }).version;
  step('6.newer-version-v3', edit2Res.statusCode === 201 && v3.versionNumber === 3,
    `POST versions 201 — v3 ${v3.id} (number 3) exists AFTER both installs`);

  // === STEP 7 — R2: the old installation STILL pins v1 ============================

  const detailRes = await inject('GET', `/organizations/${orgA.id}/workflow-repository/installations/${instV1.id}`, KEY_A);
  const detail = detailRes.json() as InstallationDetailPayload;
  step('7.R2-installation-still-pinned',
    detailRes.statusCode === 200 && detail.installation.versionId === v1.id &&
    detail.pinnedVersion.id === v1.id && detail.pinnedVersion.versionNumber === 1 &&
    detail.pinnedVersion.contentDigest === digestV1,
    `GET installation → pins v1 (id ${detail.pinnedVersion.id}, number ${detail.pinnedVersion.versionNumber}, digest ${detail.pinnedVersion.contentDigest}) — NOT v3`);

  // === STEP 8 — cross-tenant leak check on a PRIVATE workflow ====================

  const privateRes = await inject('POST', `/organizations/${orgA.id}/workflow-repository/workflows`, KEY_A, {
    slug: 'secret-runbook',
    name: 'Secret Runbook',
    visibility: 'private',
    content: { confidential: true },
    protocol: PROTOCOL,
  });
  const privateWf = (privateRes.json() as { workflow: WorkflowPayload }).workflow;
  const leakRead = await inject('GET', `/workflow-repository/workflows/${privateWf.id}`, KEY_B);
  const leakFork = await inject('POST', `/organizations/${orgB.id}/workflow-repository/forks`, KEY_B, {
    sourceWorkflowId: privateWf.id,
    sourceVersionId: (privateRes.json() as { initialVersion: VersionPayload }).initialVersion.id,
    slug: 'stolen-fork',
  });
  const leakInstall = await inject('POST', `/organizations/${orgB.id}/workflow-repository/installations`, KEY_B, {
    workflowId: privateWf.id,
    versionId: (privateRes.json() as { initialVersion: VersionPayload }).initialVersion.id,
  });
  const stolenRows = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM wfos_v2_workflows WHERE slug = 'stolen-fork'",
  );
  step('8.R5-no-cross-tenant-leak',
    leakRead.statusCode === 404 && leakFork.statusCode === 404 && leakInstall.statusCode === 404 &&
    stolenRows.rows[0]!.count === '0',
    `tenant B read/fork/install of the private workflow → 404/404/404 (uniform workflow-not-found, no existence leak); rejected fork left ${stolenRows.rows[0]!.count} durable rows`);

  // === STEP 9 — publish + fork (cross-tenant, public source) =====================

  const patchRes = await inject('PATCH', `/workflow-repository/workflows/${workflow.id}`, KEY_A, { visibility: 'public' });
  step('9.publish', patchRes.statusCode === 200 && (patchRes.json() as { workflow: WorkflowPayload }).workflow.visibility === 'public',
    `PATCH visibility → public (200)`);

  const forkRes = await inject('POST', `/organizations/${orgB.id}/workflow-repository/forks`, KEY_B, {
    sourceWorkflowId: workflow.id,
    sourceVersionId: v2.id,
    slug: 'on-call-triage-fork',
    name: 'On-call Triage (community fork)',
    visibility: 'private',
  });
  const fork = forkRes.json() as { workflow: WorkflowPayload; initialVersion: VersionPayload; created: boolean };
  step('10.R3-fork-independent-identity-and-provenance',
    forkRes.statusCode === 201 && fork.created === true &&
    fork.workflow.id !== workflow.id && fork.workflow.organizationId === orgB.id &&
    fork.workflow.forkedFromWorkflowId === workflow.id && fork.workflow.forkedFromVersionId === v2.id &&
    fork.initialVersion.versionNumber === 1 && fork.initialVersion.id !== v2.id &&
    fork.initialVersion.contentDigest === v2.contentDigest,
    `fork 201 — NEW identity ${fork.workflow.id} in org B; provenance preserved (forkedFrom workflow ${fork.workflow.forkedFromWorkflowId}, version ${fork.workflow.forkedFromVersionId}); first version ${fork.initialVersion.id} carries v2's content+digest as a NEW identity`);

  // === STEP 11 — private state did NOT transfer ==================================

  const bInstallations = await inject('GET', `/organizations/${orgB.id}/workflow-repository/installations`, KEY_B);
  const bList = (bInstallations.json() as { installations: InstallationDetailPayload[] }).installations;
  const forkInstallCount = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM wfos_v2_workflow_installations WHERE workflow_id = $1',
    [fork.workflow.id],
  );
  step('11.R3-no-private-state-transfer',
    bList.every((d) => d.installation.workflowId !== workflow.id) &&
    forkInstallCount.rows[0]!.count === '0',
    `org B has 0 installations of the source; the fork's versions have ${forkInstallCount.rows[0]!.count} installations (source private state never transfers)`);

  // === STEP 12 — R2 once more, after the fork =====================================

  const detailAfterFork = (await inject('GET', `/organizations/${orgA.id}/workflow-repository/installations/${instV1.id}`, KEY_A)).json() as InstallationDetailPayload;
  step('12.R2-pin-survives-fork',
    detailAfterFork.installation.versionId === v1.id && detailAfterFork.pinnedVersion.contentDigest === digestV1,
    `after the fork, installation ${instV1.id} STILL pins v1 (digest ${detailAfterFork.pinnedVersion.contentDigest})`);

  // === STEP 13 — provenance survives further source edits =========================

  await inject('POST', `/workflow-repository/workflows/${workflow.id}/versions`, KEY_A, { content: CONTENT_V4, protocol: PROTOCOL });
  const forkAfter = (await inject('GET', `/workflow-repository/workflows/${fork.workflow.id}`, KEY_B)).json() as { workflow: WorkflowPayload };
  const forkVersions = (await inject('GET', `/workflow-repository/workflows/${fork.workflow.id}/versions`, KEY_B)).json() as { versions: VersionPayload[] };
  step('13.R3-provenance-stable',
    forkAfter.workflow.forkedFromWorkflowId === workflow.id &&
    forkAfter.workflow.forkedFromVersionId === v2.id &&
    forkVersions.versions.length === 1,
    `after source v4, the fork still records forkedFrom(v2) and holds exactly ${forkVersions.versions.length} version — source edits never mutate the fork`);

  // === STEP 14 — R6: raw SQL tampering is rejected BY POSTGRESQL =================

  const tamperUpdate = await db
    .query('UPDATE wfos_v2_workflow_versions SET content = $1 WHERE id = $2', [JSON.stringify({ tampered: true }), v1.id])
    .then(() => 'accepted', (err: Error) => err.message);
  const tamperDelete = await db
    .query('DELETE FROM wfos_v2_workflow_versions WHERE id = $1', [v1.id])
    .then(() => 'accepted', (err: Error) => err.message);
  const tamperPin = await db
    .query('UPDATE wfos_v2_workflow_installations SET version_id = $1 WHERE id = $2', [v3.id, instV1.id])
    .then(() => 'accepted', (err: Error) => err.message);
  const tamperErase = await db
    .query('DELETE FROM wfos_v2_workflow_installations WHERE id = $1', [instV1.id])
    .then(() => 'accepted', (err: Error) => err.message);
  step('14.R6-database-rejects-tampering',
    /immutable/i.test(tamperUpdate) && /immutable/i.test(tamperDelete) && /pin/i.test(tamperPin) && /pin|immutable/i.test(tamperErase),
    `UPDATE version rejected: ${tamperUpdate.slice(0, 60)}…; DELETE version rejected: ${tamperDelete.slice(0, 60)}…; pin move rejected: ${tamperPin.slice(0, 60)}…; installation erase rejected: ${tamperErase.slice(0, 60)}…`);

  const finalV1 = (await inject('GET', `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`, KEY_A)).json() as { version: VersionPayload };
  step('15.version-untouched-after-tampering',
    finalV1.version.contentDigest === digestV1 && finalV1.version.contentDigest === v1.contentDigest,
    `after all tamper attempts, v1 digest is still ${finalV1.version.contentDigest}`);

  // === STEP 15 — no version-mutation ROUTE exists (R6 at the API surface) ========

  const mutationRoutes = await Promise.all(
    (['PUT', 'PATCH', 'DELETE'] as const).map((method) =>
      inject(method, `/workflow-repository/workflows/${workflow.id}/versions/${v1.id}`, KEY_A, { content: { tampered: true } }).then(
        (r) => r.statusCode,
      ),
    ),
  );
  step('16.R6-no-mutation-route', mutationRoutes.every((s) => s === 404),
    `PUT/PATCH/DELETE on a version path → ${mutationRoutes.join('/')} (fail-closed 404 — no such routes exist)`);

  // === wrap-up ====================================================================

  const durationMs = Date.now() - startedAt;
  await app.close();
  await db.close();
  delete process.env['WFOS_DOGFOOD_KEY_A'];
  delete process.env['WFOS_DOGFOOD_KEY_B'];

  // eslint-disable-next-line no-console
  console.log(
    `\nrunId=${runId} workflow=${workflow.id} v1=${v1.id} v2=${v2.id} v3=${v3.id} fork=${fork.workflow.id} installation=${instV1.id} digestV1=${digestV1} durationMs=${durationMs} failures=${failures}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    'OBSERVATION (scope, not failure): WorkflowRun execution is owned by V2-005 — the installation is PINNED but not EXECUTED; the execute/inspect path is deliberately absent here.',
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
