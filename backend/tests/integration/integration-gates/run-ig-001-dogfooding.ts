/**
 * IG-001 — REQUIRED REAL-SYSTEM DOGFOODING RUN (dogfooding-protocol.md).
 *
 * Executes the LITERAL frozen dogfooding clause of work order IG-001
 * (spec/architecture/v2/work-orders/IG-001.md) through the REAL product
 * path — no vitest, no mocks:
 *
 *   "Create one real workflow, persist/version it, install it, edit it into
 *    a new version, and verify both installed versions retain their intended
 *    semantics."
 *
 * Real path: the REAL DefaultWorkflowRepositoryService over the real PGlite
 * test harness (`buildAuthStack` — real PostgreSQL compiled to WASM, all
 * migrations incl. 0060_workflow_repository_v2.sql, real
 * users/organizations/memberships, the OrganizationMembershipResolver port
 * wired exactly like the gate test) + the real V2-003 WorkflowIR
 * validator/serializer/semantic digest.
 *
 * Determinism: the WorkflowIR is pure fixture data (`buildMinimalDocument`);
 * the content/semantic digests and the workflow/version/installation
 * identities are deterministic derivations of (organization, user, fixture)
 * inputs. Only run-scoped bookkeeping (wall clock + the uuid-derived
 * organization/user ids) varies between runs; every semantic assertion below
 * is fixture-deterministic. No network; PGlite in-process.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/integration-gates/run-ig-001-dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = failure to triage.
 */
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
  type WorkflowRepositoryService,
} from '../../../src/workflow-repository/index.js';
import {
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { buildMinimalDocument, withNode } from '../../unit/workflow-ir/helpers.js';

const BASE_SHA = 'def45e79db60d9b509263d2c166733ede9dc1b3d';
const PROTOCOL = { irSchemaVersion: '1' } as const;

function line(label: string, value: string): string {
  return `  ${label.padEnd(34, ' ')} ${value}`;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const wallClockStartedAtMs = Date.now();
let failed = false;

/** Emit a transcript line to stdout immediately (the transcript prints as it goes). */
function emit(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** One named assertion: printed with ✓/✗, recorded for the final verdict. */
function check(label: string, condition: boolean, detail?: string): boolean {
  if (condition) {
    emit(`✓ ${label}`);
  } else {
    failed = true;
    emit(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return condition;
}

async function run(): Promise<void> {
  const stack: TestAuthStack = await buildAuthStack({});
  try {
    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const service: WorkflowRepositoryService = new DefaultWorkflowRepositoryService({
      db: stack.db.client,
      memberships,
    });

    const org = await stack.organizationRepository.create({ name: 'IG-001 Dogfooding Org' });
    const owner = await stack.userRepository.upsertByExternalId({
      externalId: 'ig-001-dogfooding-owner',
      displayName: 'IG-001 Dogfooding Owner',
    });
    await stack.membershipRepository.assign({ userId: owner.id, organizationId: org.id, roleId: 'owner' });
    const forkOrg = await stack.organizationRepository.create({ name: 'IG-001 Dogfooding Fork Org' });
    const forkOwner = await stack.userRepository.upsertByExternalId({
      externalId: 'ig-001-dogfooding-fork-owner',
      displayName: 'IG-001 Dogfooding Fork Owner',
    });
    await stack.membershipRepository.assign({ userId: forkOwner.id, organizationId: forkOrg.id, roleId: 'owner' });

    emit('IG-001 repository ↔ WorkflowIR round-trip — dogfooding run');
    emit(line('work order', 'IG-001 — Repository ↔ WorkflowIR Integration (integration gate)'));
    emit(line('gate test', 'tests/integration/integration-gates/ig-001-repository-workflowir.integration.test.ts'));
    emit(line('base SHA', BASE_SHA));
    emit(line('wall clock start (ms)', String(wallClockStartedAtMs)));
    emit('protocol determinism: fixtures only — the WorkflowIR is pure data; digests and');
    emit('repository identities are deterministic derivations (no network, PGlite in-process).');
    emit('');

    // --- CREATE: one real workflow, persisted/versioned (immutable version 1) ---
    const authored = buildMinimalDocument();
    check('authored WorkflowIR validates through the real V2-003 validator', validateWorkflowIrDocument(authored).ok);
    const authoredBytes = serializeWorkflowIrDocument(authored);
    const authoredDigest = computeWorkflowVersionSemanticDigest(authored).digest;

    const created = await service.createWorkflow(
      { userId: owner.id },
      {
        organizationId: org.id,
        slug: 'ig-001-dogfooding',
        name: 'IG-001 Dogfooding',
        visibility: 'private',
        content: authored as unknown as Record<string, unknown>,
        protocol: PROTOCOL,
      },
    );
    check('workflow created through the real repository service (created=true)', created.created);
    const v1 = created.initialVersion;
    check('workflow is born with immutable version 1 (versionNumber=1)', v1.versionNumber === 1);

    emit('');
    emit('CREATE — one real workflow, persisted/versioned');
    emit(line('workflow id', created.workflow.id));
    emit(line('version id', v1.id));
    emit(line('version number', String(v1.versionNumber)));
    emit(line('content digest (V2-002)', v1.contentDigest));
    emit(line('semantic digest (V2-003)', authoredDigest));

    // --- INSTALL v1 ---
    const installedA = await service.installVersion(
      { userId: owner.id },
      { organizationId: org.id, workflowId: created.workflow.id, versionId: v1.id },
    );
    check('version 1 installed (created=true)', installedA.created);
    check('installation A pins exactly version 1', installedA.installation.versionId === v1.id);

    emit('');
    emit('INSTALL v1');
    emit(line('installation id', installedA.installation.id));
    emit(line('pinned version', `${v1.id} (#${v1.versionNumber})`));

    // --- EDIT into v2 (the observe node's capability becomes workflow.observe) ---
    const edited = withNode(jsonClone(authored), 'observe', {
      spec: { class: 'deterministic_api', capability: 'workflow.observe' },
      capabilityRequirements: ['workflow.observe'],
    });
    check('edited WorkflowIR validates through the real V2-003 validator', validateWorkflowIrDocument(edited).ok);
    const editedBytes = serializeWorkflowIrDocument(edited);
    const editedDigest = computeWorkflowVersionSemanticDigest(edited).digest;

    const v2Result = await service.createVersion(
      { userId: owner.id },
      created.workflow.id,
      { content: edited as unknown as Record<string, unknown>, protocol: PROTOCOL },
    );
    const v2 = v2Result.version;
    check('version 2 created through the real repository service (created=true)', v2Result.created);
    check('version 2 has a new immutable identity (id ≠ v1)', v2.id !== v1.id);
    check('v2 semantic digest ≠ v1 semantic digest (the edit is real)', editedDigest !== authoredDigest);

    emit('');
    emit('EDIT into v2 — observe node capability browser.observe → workflow.observe');
    emit(line('version id', v2.id));
    emit(line('version number', String(v2.versionNumber)));
    emit(line('content digest (V2-002)', v2.contentDigest));
    emit(line('semantic digest (V2-003)', editedDigest));

    // --- INSTALL v2 ---
    const installedB = await service.installVersion(
      { userId: owner.id },
      { organizationId: org.id, workflowId: created.workflow.id, versionId: v2.id },
    );
    check('version 2 installed (created=true)', installedB.created);
    check(
      'installation B is a SECOND coexisting installation (id ≠ installation A)',
      installedB.installation.id !== installedA.installation.id,
    );

    emit('');
    emit('INSTALL v2');
    emit(line('installation id', installedB.installation.id));
    emit(line('pinned version', `${v2.id} (#${v2.versionNumber})`));

    // --- VERIFY BOTH: both installed versions retain their intended semantics ---
    emit('');
    emit('VERIFY BOTH — both installed versions retain their intended semantics');
    const listed = await service.listInstallations({ userId: owner.id }, org.id);
    check('the organization lists exactly 2 installations', listed.length === 2, `observed ${listed.length}`);

    // Installation A: pins v1; v1 re-fetch byte + digest equality.
    const detailA = await service.getInstallation({ userId: owner.id }, org.id, installedA.installation.id);
    check('installation A pins version 1', detailA.pinnedVersion.id === v1.id);
    check('installation A pinned version number is 1', detailA.pinnedVersion.versionNumber === 1);
    const fetchedV1 = await service.getVersion({ userId: owner.id }, created.workflow.id, v1.id);
    const fetchedV1Bytes = serializeWorkflowIrDocument(fetchedV1.content as unknown as WorkflowIrDocument);
    const fetchedV1Digest = computeWorkflowVersionSemanticDigest(fetchedV1.content as unknown as WorkflowIrDocument).digest;
    check('re-fetched v1 serialized bytes equal the authored v1 bytes', fetchedV1Bytes === authoredBytes);
    check('re-fetched v1 semantic digest equals the authored v1 semantic digest', fetchedV1Digest === authoredDigest);
    emit('  installation A');
    emit(line('pinned version id', detailA.pinnedVersion.id));
    emit(line('pinned version number', String(detailA.pinnedVersion.versionNumber)));
    emit(line('pinned content digest', detailA.pinnedVersion.contentDigest));
    emit('    installation A RETAINS SEMANTICS: YES');

    // Installation B: pins v2; v2 re-fetch byte + digest equality.
    const detailB = await service.getInstallation({ userId: owner.id }, org.id, installedB.installation.id);
    check('installation B pins version 2', detailB.pinnedVersion.id === v2.id);
    check('installation B pinned version number is 2', detailB.pinnedVersion.versionNumber === 2);
    const fetchedV2 = await service.getVersion({ userId: owner.id }, created.workflow.id, v2.id);
    const fetchedV2Bytes = serializeWorkflowIrDocument(fetchedV2.content as unknown as WorkflowIrDocument);
    const fetchedV2Digest = computeWorkflowVersionSemanticDigest(fetchedV2.content as unknown as WorkflowIrDocument).digest;
    check('re-fetched v2 serialized bytes equal the authored v2 bytes', fetchedV2Bytes === editedBytes);
    check('re-fetched v2 semantic digest equals the authored v2 semantic digest', fetchedV2Digest === editedDigest);
    emit('  installation B');
    emit(line('pinned version id', detailB.pinnedVersion.id));
    emit(line('pinned version number', String(detailB.pinnedVersion.versionNumber)));
    emit(line('pinned content digest', detailB.pinnedVersion.contentDigest));
    emit('    installation B RETAINS SEMANTICS: YES');

    // --- FORK: provenance preserved, independent identity, no installation transfer ---
    emit('');
    emit('FORK — provenance preserved, independent identity, installations never transfer');
    await service.updateWorkflow({ userId: owner.id }, created.workflow.id, { visibility: 'public' });
    const fork = await service.forkWorkflow(
      { userId: forkOwner.id },
      {
        organizationId: forkOrg.id,
        sourceWorkflowId: created.workflow.id,
        sourceVersionId: v1.id,
        slug: 'ig-001-dogfooding-forked',
        name: 'IG-001 Dogfooding Forked',
      },
    );
    const forkDigest = computeWorkflowVersionSemanticDigest(
      fork.initialVersion.content as unknown as WorkflowIrDocument,
    ).digest;
    check('fork created (created=true) with an independent workflow identity', fork.created && fork.workflow.id !== created.workflow.id);
    check('fork initial version has a new identity (id ≠ source v1)', fork.initialVersion.id !== v1.id);
    check('fork preserves provenance (forkedFromWorkflowId = source)', fork.workflow.forkedFromWorkflowId === created.workflow.id);
    check('fork preserves provenance (forkedFromVersionId = source v1)', fork.workflow.forkedFromVersionId === v1.id);
    check('fork initial version carries the source semantic digest', forkDigest === authoredDigest);
    const forkOrgInstallations = await service.listInstallations({ userId: forkOwner.id }, forkOrg.id);
    check('installations NOT transferred: the fork org lists 0 installations', forkOrgInstallations.length === 0, `observed ${forkOrgInstallations.length}`);
    const sourceInstallations = await service.listInstallations({ userId: owner.id }, org.id);
    check('the source org still lists exactly 2 installations', sourceInstallations.length === 2, `observed ${sourceInstallations.length}`);
    emit(line('fork workflow id', fork.workflow.id));
    emit(line('fork version id', fork.initialVersion.id));
    emit(line('forkedFromWorkflowId', fork.workflow.forkedFromWorkflowId ?? '<null>'));
    emit(line('forkedFromVersionId', fork.workflow.forkedFromVersionId ?? '<null>'));
    emit(line('fork semantic digest', forkDigest));
    emit(line('fork org installations', String(forkOrgInstallations.length)));

    // --- Verdict ---
    emit('');
    emit(
      failed
        ? 'RESULT: both installed versions retain their intended semantics — FAIL'
        : 'RESULT: both installed versions retain their intended semantics — PASS',
    );
    emit(
      failed
        ? 'RESULT: fork preserved provenance with an independent identity and transferred no installations — FAIL'
        : 'RESULT: fork preserved provenance with an independent identity and transferred no installations — PASS',
    );
    emit(line('wall duration (ms)', String(Date.now() - wallClockStartedAtMs)));

    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await stack.teardown();
  }
}

try {
  await run();
} catch (err) {
  process.stderr.write(
    `IG-001 dogfooding run aborted by an unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
}
