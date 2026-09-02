/**
 * V2-005 — REQUIRED REAL-SYSTEM DOGFOODING EXPERIMENT (dogfooding-protocol.md;
 * work order V2-005 "Dogfooding" + issue #133).
 *
 * Runs the experiment through REAL product paths:
 *
 *   real PGlite (actual PostgreSQL compiled to WASM — the platform's
 *   pglite-database-client, the same single persistence boundary as
 *   production `pg`) → real migration-runner (ALL 61 migrations incl.
 *   0061_workflow_runs_v2.sql) → real identity stack (users / organizations /
 *   memberships / API-key auth provider + credential provisioner) → REAL
 *   Fastify apps built by buildServer with the REAL V2-002
 *   workflow-repository routes AND the REAL V2-005 workflow-runs routes →
 *   every step driven over HTTP via app.inject().
 *
 * Experiment (V2-005 work order "Dogfooding" + brief):
 *
 *   1. EXECUTE A REAL WORKFLOW — author the support-ticket-triage workflow
 *      with the merged V2-003 builder (semantic digest pinned byte-identical
 *      to the merged V2-003/V2-014 dogfooding evidence — cross-work-order
 *      continuity), create + INSTALL (pin) its immutable version 1 through
 *      the real V2-002 routes, then REQUEST a run of the installed version
 *      through the REAL V2-005 run route with a real principal, the
 *      installation pin, and real input commitments (real SHA-256 over real
 *      local artifact files). Duplicate trigger delivery converges on ONE run.
 *   2. DRIVE THE RUN — step started/completed records for the DECLARED steps
 *      (validated against the pinned version), capability invocation records
 *      with canonical registry names, and DISTINCT evidence classes: intent,
 *      claim, observation (real SHA-256 over real local artifacts + a real
 *      fs.stat observation), human_confirmation.
 *   3. PAUSE MID-RUN, RESUME TO THE EXACT STEP — through the real routes
 *      (pause AT notify_channel; resume returns resumedAtStepId =
 *      notify_channel on the SAME attempt).
 *   4. CRASH + FRESH INSTANCE — the first service instance + Fastify app are
 *      DISPOSED mid-run (while paused); a FRESH instance over the SAME
 *      database resumes to the exact step (reconstruction-driven resume) and
 *      a post-crash duplicate command converges idempotently (no second side
 *      effect; the command log proves exactly-once).
 *   5. REAL EXECUTION ATTESTATION — the execution host produces a REAL
 *      V2-014 ExecutionAttestation (real Ed25519 key pair, real workload
 *      artifacts with real SHA-256 commitments, a real causal-parent
 *      execution digest, statement bound to the EXACT run/attempt/step/
 *      version/deployment) and attaches it through the REAL route — the Run
 *      boundary verifies digest, statement binding, freshness, and records
 *      the binding + DISTINCT verification-class evidence.
 *   6. NEGATIVE EXPERIMENTS, ALL TYPED — (a) MODIFIED attestation (mutated
 *      statement, not re-signed); (b) MISMATCHED attestation (a REAL second
 *      attestation bound to a DIFFERENT run); (c) the SAME valid attestation
 *      again → DURABLE single-use rejection (also rejected by a FRESH service
 *      instance — durability proof); (d) STALE attestation (expired validity
 *      window). None becomes verification evidence.
 *   7. UNAUTHORIZED COMPLETION from another tenant → typed uniform 404 (zero
 *      leakage); run state untouched. Then the authorized principal COMPLETES
 *      the run.
 *   8. RECONSTRUCT the execution history from the persisted Run ALONE — a
 *      FRESH service instance AND a fresh route read rebuild the full
 *      history (state timeline, attempts, steps in order, invocations,
 *      evidence with classes + provenance, attestation bindings, typed
 *      rejections, the command log) — asserted exactly equal to each other
 *      and to the expected recorded content. This is simultaneously the
 *      crash-recovery proof.
 *   9. DETERMINISM — the whole experiment runs TWICE (fresh PGlite + fresh
 *      identity stack + fresh Ed25519 key pair per run); the two transcripts
 *      are compared after normalizing run-scoped bookkeeping (uuid-derived
 *      org/workflow/version/installation ids, the deterministic run-derived
 *      ids, key-derived attestation material, wall duration) — V2-006
 *      precedent.
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/workflow-runs/run-execute-pause-resume-reconstruct-dogfooding.ts
 *
 * Exit code 0 = every assertion held (PASS); non-zero = a failure to triage.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
import { DefaultWorkflowRepositoryService } from '../../../src/workflow-repository/index.js';
import type { OrganizationMembershipResolver } from '../../../src/workflow-repository/index.js';
import {
  createWorkflowIrBuilder,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';
import type { ControlEdge, WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { deriveNodeKeyFingerprint } from '../../../src/node-capability/index.js';
import {
  computeExecutionDigest,
  executionValueCommitment,
  generateAttesterKeyPair,
  serializeAttestation,
  signExecutionAttestation,
  validateExecutionStatement,
} from '../../../src/execution-attestation/index.js';
import type { ExecutionStatement } from '../../../src/execution-attestation/index.js';
import {
  DefaultWorkflowRunService,
  formatUtcTimestamp,
} from '../../../src/workflow-runs/index.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Injected deterministic sources (fixed constants — no ambient clock in the
// protocol path; the wall clock appears ONLY in the harness's run-instance
// bookkeeping, printed outside the compared transcripts).
// ---------------------------------------------------------------------------

/** Deterministic run-clock base: 2026-09-01T12:00:00.000Z, 1s step. */
const CLOCK_BASE_MS = 1_788_264_000_000;
const CLOCK_STEP_MS = 1000;
/** The boundary's freshness `now` for the STALE experiment. */
const STALE_NOW = '2026-09-01T12:06:00.000Z';
/** Deterministic protocol epoch (V2-014 freshness). */
const EPOCH = 7;

const EXECUTED_AT = '2026-09-01T12:00:00.000Z';
const VALID_UNTIL = '2026-09-01T12:05:00.000Z';
const ISSUED_AT = '2026-09-01T12:00:01.000Z';

const OPERATOR_KEY = 'v2-005-dogfood-operator-key';
const OUTSIDER_KEY = 'v2-005-dogfood-outsider-key';

// ---------------------------------------------------------------------------
// Real binding reference data (cross-work-order continuity, reproduced)
// ---------------------------------------------------------------------------

/** The merged V2-003/V2-014 dogfooding evidence digest of this exact workflow. */
const V2_003_EVIDENCE_DIGEST = '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37';
/** The merged V2-004 dogfooding device-host node identity. */
const V2_004_EVIDENCE_NODE_ID = 'node_795e8b12eaef3e45';
/** The real V2-004 dogfooding node key seed (browser/device host). */
const V2_004_DOGFOOD_NODE_KEY_SEED = 'v2-004-dogfood-browser-host-key';

const WORKLOAD_IDENTITY = 'wl_v2-005-dogfood-triage-runner';
const CORRELATION = 'delivery-v2-005-dogfood-0001';

// ---------------------------------------------------------------------------
// The real authored workflow (merged V2-003 builder; support-ticket triage —
// the SAME workflow as the merged V2-003/V2-014 dogfooding evidence)
// ---------------------------------------------------------------------------

const issueObjectType = {
  kind: 'object',
  fields: [
    { name: 'title', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

const fetchIssue: WorkflowNode = {
  id: 'fetch_issue',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
    { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
  ],
  outputs: [{ name: 'issue', type: issueObjectType }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const draftSummary: WorkflowNode = {
  id: 'draft_summary',
  executionClass: 'agentic_computer_use',
  spec: { class: 'agentic_computer_use', task: 'Draft a triage summary and severity classification for the inbound GitHub issue.' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'issue', type: issueObjectType, binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' } },
  ],
  outputs: [
    { name: 'summary', type: { kind: 'string' } },
    { name: 'severity', type: { kind: 'string' } },
  ],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
};

const reviewGate: WorkflowNode = {
  id: 'review_gate',
  executionClass: 'human',
  spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve posting the triage summary and syncing the backlog for this issue.' } },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

const notifyChannel: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [
    { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
    { name: 'channel', type: { kind: 'string' }, optional: true, binding: { kind: 'workflow_input', input: 'channel' } },
    { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' } },
  ],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

const syncBacklog: WorkflowNode = {
  id: 'sync_backlog',
  executionClass: 'subworkflow',
  spec: { class: 'subworkflow', subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192837465afdeadbeef-candidate-1' } },
  capabilityRequirements: ['workflow.execute'],
  placement: 'any_supported_node',
  inputs: [
    { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
  ],
  outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
};

const logRejection: WorkflowNode = {
  id: 'log_rejection',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'filesystem.write' },
  capabilityRequirements: ['filesystem.write'],
  placement: 'device_local',
  inputs: [
    { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'rejected-triage.log' } },
    { name: 'content', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' } },
  ],
  outputs: [],
  failurePolicy: { strategy: 'ignore_and_continue' },
};

const triageEdges: ControlEdge[] = [
  { from: 'fetch_issue', to: 'draft_summary', on: 'success' },
  { from: 'draft_summary', to: 'review_gate', on: 'success' },
  { from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } },
];

function authorTriageWorkflow(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'channel', type: { kind: 'string' }, optional: true })
    .addWorkflowOutput({ name: 'summary', type: { kind: 'string' }, from: { kind: 'node_output', node: 'draft_summary', output: 'summary' } })
    .addWorkflowOutput({ name: 'messageId', type: { kind: 'string' }, from: { kind: 'node_output', node: 'notify_channel', output: 'messageId' } })
    .addNode(fetchIssue)
    .addNode(draftSummary)
    .addNode(reviewGate)
    .addNode(notifyChannel)
    .addNode(syncBacklog)
    .addNode(logRejection)
    .addEdge(triageEdges[0] as ControlEdge)
    .addEdge(triageEdges[1] as ControlEdge)
    .addEdge(triageEdges[2] as ControlEdge)
    .addEdge(triageEdges[3] as ControlEdge)
    .addEdge(triageEdges[4] as ControlEdge)
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withCompatibility({ compatibilityLevel: 'equivalent', inputSurfaceChange: 'none', outputSurfaceChange: 'none' })
    .build();
}

// ---------------------------------------------------------------------------
// The real deterministic local workload (real artifact files, real sha-256)
// ---------------------------------------------------------------------------

/** The real inbound issue (the run's input artifact). */
const INBOUND_ISSUE =
  '{"issue":4322,"title":"workflow run state lost after restart","body":"executed runs disappear when the executor restarts mid-flight"}';

/** Deterministic draft-summary artifact (draft_summary output). */
const DRAFT_SUMMARY_TEXT =
  '[TRIAGE-CARD-77f3e] pectoraux/WorkflowOS issue #4322 "workflow run state lost after restart" — ' +
  'severity: high — summary: durable run state + evidence persistence required; recommend the V2-005 run boundary.';

/** Deterministic approval record (review_gate output — the human confirmation). */
const APPROVAL_RECORD =
  '{"gate":"review_gate","decision":"approved","approvedBy":"v2-005-dogfood-operator","at":"2026-09-01T12:00:10.000Z"}';

/** Deterministic notification payload (notify_channel output). */
const NOTIFY_PAYLOAD =
  '[TRIAGE-CARD-77f3e] high-severity issue #4322 — approved triage summary posted to the team notifications channel.';

/** Deterministic message-id artifact (the run's claimed output). */
const MESSAGE_ID_RECORD =
  '{"messageId":"msg-dogfood-4322-0001","channel":"team-notifications","postedAt":"2026-09-01T12:00:20.000Z"}';

/** The observation record of a local artifact (a real fs observation, path-normalized). */
function observationRecordOf(file: string): string {
  const stats = statSync(file);
  const parts = file.split('/');
  const name = parts[parts.length - 1] ?? file;
  return JSON.stringify({ observedArtifact: name, sizeBytes: stats.size, mode: stats.mode });
}

// ---------------------------------------------------------------------------
// The deterministic injected run clock (stepping base clock + a settable
// freshness override for the STALE experiment — injected, never ambient)
// ---------------------------------------------------------------------------

interface SettableRunClock {
  now(): string;
  setNow(next: string): void;
  clearOverride(): void;
}

function createDeterministicRunClock(): SettableRunClock {
  let current = CLOCK_BASE_MS;
  let override: string | null = null;
  return {
    now: () => {
      if (override !== null) return override;
      const stamp = formatUtcTimestamp(current);
      current += CLOCK_STEP_MS;
      return stamp;
    },
    setNow: (next: string) => {
      override = next;
    },
    clearOverride: () => {
      override = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript + run-scoped-value normalization (determinism comparison)
// ---------------------------------------------------------------------------

/**
 * Run-scoped value shapes: uuid-derived ids, V2-002/V2-005/V2-014 prefixed
 * derived identities, and 64-hex digests (the digests that bind run-scoped
 * identities — e.g. ExecutionDigest over a statement containing the run id —
 * are themselves run-scoped; the cross-run-stable digests are asserted
 * in-code against their pinned constants).
 */
const RUN_SCOPED_VALUE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|wfw_[0-9a-f]+|wfwv_[0-9a-f]+|wfin_[0-9a-f]+|wfr[a-z]?_[0-9a-f]+|wfea[a-z]*_[0-9a-f]+|[0-9a-f]{64})$/;

interface ExperimentResult {
  readonly label: string;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
}

/** One experiment execution (a full transcript + typed failure list). */
async function executeExperiment(label: string): Promise<ExperimentResult> {
  const lines: string[] = [];
  const failures: string[] = [];
  const idMap = new Map<string, string>();

  /** Replace a run-scoped value with its stable capture-order placeholder. */
  const norm = (value: string): string => {
    if (RUN_SCOPED_VALUE.test(value)) {
      if (!idMap.has(value)) idMap.set(value, `<scoped:${idMap.size}>`);
      return idMap.get(value) as string;
    }
    return value;
  };

  const check = (name: string, held: boolean, detail: string): void => {
    if (held) {
      lines.push(`  [ok]   ${label}: ${name} — ${detail}`);
    } else {
      lines.push(`  [FAIL] ${label}: ${name} — ${detail}`);
      failures.push(`${label}: ${name}: ${detail}`);
    }
  };

  const section = (title: string): void => {
    lines.push('');
    lines.push(`--- ${label}: ${title}`);
  };

  const say = (text: string): void => {
    lines.push(`        ${text}`);
  };

  // === infrastructure: real PGlite + ALL 61 migrations ======================

  section('infrastructure (real PGlite + migration-runner)');
  const db = await createPgliteDatabaseClient();
  const logger = createLogger({ level: 'info' });
  const applied = await runMigrations(db, logger);
  check(
    'infra.migrations',
    applied.length === 61 && applied.includes('0060_workflow_repository_v2.sql') && applied.includes('0061_workflow_runs_v2.sql'),
    `real PGlite + migration-runner applied ${applied.length} migrations (0060 + 0061 workflow-runs present)`,
  );

  // === real identity stack (two tenants) ====================================

  const userRepository = new PgUserRepository(db);
  const organizationRepository = new PgOrganizationRepository(db);
  const membershipRepository = new PgMembershipRepository(db);

  const org = await organizationRepository.create({ name: 'V2-005 Dogfood Org (operator tenant)' });
  const outsiderOrg = await organizationRepository.create({ name: 'V2-005 Dogfood Outsider Org' });
  const operator = await userRepository.upsertByExternalId({
    externalId: 'v2-005-dogfood-operator',
    displayName: 'V2-005 Dogfood Operator',
  });
  const outsider = await userRepository.upsertByExternalId({
    externalId: 'v2-005-dogfood-outsider',
    displayName: 'V2-005 Dogfood Outsider',
  });
  await membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
  await membershipRepository.assign({ userId: outsider.id, organizationId: outsiderOrg.id, roleId: 'owner' });
  const provisioner = new ApiKeyCredentialProvisioner(db);
  await provisioner.provision({
    keyId: 'v2-005-dogfood-operator-key',
    secretRef: 'WFOS_V2_005_DOGFOOD_OPERATOR_KEY',
    externalId: 'v2-005-dogfood-operator',
    label: 'V2-005 Dogfood Operator',
    rawKey: OPERATOR_KEY,
  });
  await provisioner.provision({
    keyId: 'v2-005-dogfood-outsider-key',
    secretRef: 'WFOS_V2_005_DOGFOOD_OUTSIDER_KEY',
    externalId: 'v2-005-dogfood-outsider',
    label: 'V2-005 Dogfood Outsider',
    rawKey: OUTSIDER_KEY,
  });

  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db, memberships });

  const clock = createDeterministicRunClock();
  const makeRunService = () =>
    new DefaultWorkflowRunService({
      db,
      memberships,
      workflowRepository: repository,
      clock,
      currentEpoch: EPOCH,
    });
  const authProvider = new ApiKeyAuthProvider(db, new EnvSecretStore());

  const buildApp = async (): Promise<FastifyInstance> => {
    const app = await buildServer({
      queue: new InMemoryQueue(),
      logger,
      auth: { authProvider, userRepository },
      workflowRepository: { workflowRepositoryService: repository },
      workflowRuns: { workflowRunService: makeRunService() },
    });
    await app.ready();
    return app;
  };

  const inject = (app: FastifyInstance, method: string, url: string, payload?: unknown, key = OPERATOR_KEY) =>
    app.inject({
      method: method as never,
      url,
      headers: { 'x-api-key': key },
      payload: payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as never),
    });

  // === 1. EXECUTE A REAL WORKFLOW (V2-002 routes + V2-005 run route) ========

  section('1. install the real workflow + start a real run (real routes)');
  const document = authorTriageWorkflow();
  const semantic = computeWorkflowVersionSemanticDigest(document);
  check(
    '1.authored-workflow-pinned',
    semantic.digest === V2_003_EVIDENCE_DIGEST && semantic.domain === 'workflowos/workflow-ir/v1',
    `the authored support-ticket-triage semantic digest is byte-identical to the merged V2-003/V2-014 dogfooding evidence digest (${semantic.digest})`,
  );

  const app1 = await buildApp();

  const createRes = await inject(app1, 'POST', `/organizations/${org.id}/workflow-repository/workflows`, {
    slug: 'support-ticket-triage',
    name: 'Support Ticket Triage',
    description: 'Triage an inbound support ticket and reply',
    visibility: 'private',
    content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  const created = createRes.json() as {
    workflow: { id: string; headVersionId: string };
    initialVersion: { id: string; versionNumber: number; contentDigest: string };
  };
  const workflowId = created.workflow.id;
  const version1Id = created.initialVersion.id;
  check(
    '1.create-workflow',
    createRes.statusCode === 201 && created.initialVersion.versionNumber === 1,
    `POST /workflow-repository/workflows 201 — workflow ${norm(workflowId)} born with immutable version 1 (${norm(version1Id)})`,
  );

  const installRes = await inject(app1, 'POST', `/organizations/${org.id}/workflow-repository/installations`, {
    workflowId,
    versionId: version1Id,
  });
  const installation = (installRes.json() as { installation: { id: string; versionId: string; status: string } }).installation;
  check(
    '1.install-pin-version',
    installRes.statusCode === 201 && installation.versionId === version1Id && installation.status === 'enabled',
    `POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (${norm(installation.id)}, status enabled)`,
  );

  const readRes = await inject(app1, 'GET', `/workflow-repository/workflows/${workflowId}/versions/${version1Id}`);
  const readVersion = (readRes.json() as { version: { contentDigest: string; content: Record<string, unknown> } }).version;
  const roundTrip = parseWorkflowIrDocument(JSON.stringify(readVersion.content));
  const roundTripDigest = roundTrip.ok ? computeWorkflowVersionSemanticDigest(roundTrip.document) : null;
  check(
    '1.read-back-pin-integrity',
    readRes.statusCode === 200 && roundTripDigest !== null && roundTripDigest.digest === V2_003_EVIDENCE_DIGEST,
    `GET the installed version over HTTP → 200; the HTTP-read content re-parses and its semantic digest still equals the pin (${roundTripDigest?.digest ?? '<unparseable>'})`,
  );

  // real input artifacts (real local files, real sha-256 commitments)
  const runDir = mkdtempSync(join(tmpdir(), 'v2-005-dogfood-'));
  mkdirSync(runDir, { recursive: true });
  const issueFile = join(runDir, 'inbound-issue.json');
  writeFileSync(issueFile, INBOUND_ISSUE, 'utf8');
  const inputCommitment = executionValueCommitment(readFileSync(issueFile));

  const requestBody = {
    commandId: 'cmd-dogfood-0001',
    correlationId: CORRELATION,
    causationId: 'evt-webhook-issue-4322',
    workflowId,
    versionId: version1Id,
    installationId: installation.id,
    trigger: { type: 'webhook', id: 'delivery-v2-005-dogfood-0001' },
    inputCommitments: [inputCommitment],
  };
  const requestRes = await inject(app1, 'POST', `/organizations/${org.id}/workflow-runs/runs`, requestBody);
  const requested = requestRes.json() as {
    run: {
      id: string; state: string; workflowId: string; versionId: string; versionSemanticDigest: string;
      versionContentDigest: string; installationId: string | null; inputDigest: string;
      trigger: { type: string; id: string };
    };
    created: boolean;
    executed: boolean;
  };
  const runId = requested.run.id;
  check(
    '1.request-run',
    requestRes.statusCode === 201 && requested.created && requested.run.state === 'requested',
    `POST /workflow-runs/runs 201 — run ${norm(runId)} REQUESTED (state requested)`,
  );
  check(
    '1.run-pin',
    requested.run.workflowId === workflowId && requested.run.versionId === version1Id &&
      requested.run.installationId === installation.id &&
      requested.run.versionSemanticDigest === V2_003_EVIDENCE_DIGEST &&
      requested.run.versionContentDigest === readVersion.contentDigest &&
      requested.run.trigger.type === 'webhook' && requested.run.trigger.id === 'delivery-v2-005-dogfood-0001',
    `the run pins the EXACT (workflow, version) tuple + the installation ${norm(installation.id)} + the pinned semantic digest ${requested.run.versionSemanticDigest}`,
  );
  check(
    '1.run-input-commitments',
    /^[0-9a-f]{64}$/.test(requested.run.inputDigest),
    `the run's input identity is a one-way commitment digest over the real input artifact (${norm(requested.run.inputDigest)}); raw input never enters`,
  );
  const nodeKeyMaterial = createHash('sha256').update(V2_004_DOGFOOD_NODE_KEY_SEED).digest();
  const nodeId = deriveNodeKeyFingerprint(new Uint8Array(nodeKeyMaterial));
  check(
    '1.node-identity-continuity',
    nodeId === V2_004_EVIDENCE_NODE_ID,
    `the execution host identity is the merged V2-004 dogfooding device host (deriveNodeKeyFingerprint over the V2-004 key seed → ${nodeId})`,
  );

  // duplicate event delivery (different command id, SAME trigger identity)
  const dupDelivery = await inject(app1, 'POST', `/organizations/${org.id}/workflow-runs/runs`, {
    ...requestBody,
    commandId: 'cmd-dogfood-0002',
  });
  const dupBody = dupDelivery.json() as { run: { id: string }; created: boolean; executed: boolean };
  check(
    '1.duplicate-event-delivery-converges',
    dupDelivery.statusCode === 200 && dupBody.run.id === runId && !dupBody.created,
    `duplicate trigger delivery under a NEW command id → 200 converged on the SAME run ${norm(runId)} (created=false; one run per trigger surface)`,
  );
  const cmdReplay = await inject(app1, 'POST', `/organizations/${org.id}/workflow-runs/runs`, requestBody);
  const cmdReplayBody = cmdReplay.json() as { run: { id: string }; executed: boolean };
  check(
    '1.duplicate-command-replay-converges',
    cmdReplay.statusCode === 200 && cmdReplayBody.run.id === runId && !cmdReplayBody.executed,
    `replayed command id → 200, executed=false, converged on ${norm(runId)} (typed idempotent convergence, no second side effect)`,
  );

  // === 2. DRIVE THE RUN (steps + invocations + distinct evidence classes) ===

  section('2. drive the run (declared steps, canonical invocations, distinct evidence)');
  // intent evidence: the trigger's intent (a distinct class, no registry event)
  const intentEvidence = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/evidence`, {
    commandId: 'cmd-dogfood-0003',
    correlationId: CORRELATION,
    evidenceClass: 'intent',
    producerKind: 'trigger',
    producerId: 'webhook-delivery-v2-005-dogfood-0001',
    contentCommitment: executionValueCommitment(INBOUND_ISSUE),
    description: 'the webhook trigger delivery that requested the run',
  });
  check(
    '2.evidence-intent',
    intentEvidence.statusCode === 201 && (intentEvidence.json() as { evidence: { evidenceClass: string } }).evidence.evidenceClass === 'intent',
    `intent evidence recorded (class intent, producer webhook trigger; no registry event — classes never impersonate protocol events)`,
  );

  const startRes = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/start`, {
    commandId: 'cmd-dogfood-0004',
    correlationId: CORRELATION,
    nodeId: V2_004_EVIDENCE_NODE_ID,
  });
  const started = startRes.json() as {
    run: { state: string };
    attempt: { id: string; attemptNumber: number; state: string; nodeId: string | null };
  };
  check(
    '2.start-run',
    startRes.statusCode === 200 && started.run.state === 'running' && started.attempt.attemptNumber === 1 && started.attempt.state === 'running',
    `POST /start 200 — run RUNNING, attempt #1 running on the V2-004 dogfooding device host ${started.attempt.nodeId ?? ''}`,
  );

  /** One declared step: started → invocation (canonical capability) → completed. */
  const driveStep = async (
    app: FastifyInstance,
    stepId: string,
    capability: string,
    executionClass: string,
    cmdBase: string,
    outputCommitments: string[],
  ): Promise<void> => {
    const startedStep = await inject(app, 'POST', `/workflow-runs/runs/${runId}/steps/${stepId}/started`, {
      commandId: `${cmdBase}-a`,
      correlationId: CORRELATION,
      inputCommitments: [inputCommitment],
    });
    check(
      `2.step-started-${stepId}`,
      startedStep.statusCode === 200 && (startedStep.json() as { step: { status: string } }).step.status === 'started',
      `step ${stepId} started (declared by the pinned version; attempt #1)`,
    );
    const inv = await inject(app, 'POST', `/workflow-runs/runs/${runId}/invocations`, {
      commandId: `${cmdBase}-b`,
      correlationId: CORRELATION,
      capability,
      executionClass,
      stepId,
      inputCommitments: [inputCommitment],
    });
    const invocation = (inv.json() as { invocation: { id: string; capability: string; executionClass: string } }).invocation;
    check(
      `2.invocation-${stepId}`,
      inv.statusCode === 200 && invocation.capability === capability && invocation.executionClass === executionClass,
      `capability invocation ${capability} (${executionClass}) requested — canonical registry name verbatim (${norm(invocation.id)})`,
    );
    const invDone = await inject(app, 'POST', `/workflow-runs/runs/${runId}/invocations/${invocation.id}/completed`, {
      commandId: `${cmdBase}-c`,
      correlationId: CORRELATION,
      outcome: 'succeeded',
      outputCommitments,
    });
    check(
      `2.invocation-completed-${stepId}`,
      invDone.statusCode === 200 && (invDone.json() as { invocation: { outcome: string } }).invocation.outcome === 'succeeded',
      `invocation ${capability} completed (the executor's claimed outcome — a claim, never side-effect evidence)`,
    );
    const stepDone = await inject(app, 'POST', `/workflow-runs/runs/${runId}/steps/${stepId}/completed`, {
      commandId: `${cmdBase}-d`,
      correlationId: CORRELATION,
      outcome: 'succeeded',
      outputCommitments,
    });
    check(
      `2.step-completed-${stepId}`,
      stepDone.statusCode === 200 && (stepDone.json() as { step: { status: string; outcome: string } }).step.status === 'completed',
      `step ${stepId} completed (succeeded)`,
    );
  };

  // fetch_issue: real workload — read the issue artifact back, produce the fetched issue
  const fetchedIssueFile = join(runDir, 'fetched-issue.txt');
  writeFileSync(fetchedIssueFile, `fetched: ${INBOUND_ISSUE}`, 'utf8');
  await driveStep(app1, 'fetch_issue', 'github.repository.read', 'deterministic_api', 'cmd-dogfood-0005', [
    executionValueCommitment(readFileSync(fetchedIssueFile)),
  ]);

  // draft_summary: real workload — write the draft artifact
  const draftSummaryFile = join(runDir, 'draft-summary.txt');
  writeFileSync(draftSummaryFile, DRAFT_SUMMARY_TEXT, 'utf8');
  await driveStep(app1, 'draft_summary', 'github.repository.read', 'agentic_computer_use', 'cmd-dogfood-0009', [
    executionValueCommitment(readFileSync(draftSummaryFile)),
  ]);

  // claim evidence: the executor's CLAIM (never observation, never verification)
  const claimEvidence = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/evidence`, {
    commandId: 'cmd-dogfood-0013',
    correlationId: CORRELATION,
    evidenceClass: 'claim',
    producerKind: 'executor',
    producerId: V2_004_EVIDENCE_NODE_ID,
    contentCommitment: executionValueCommitment(DRAFT_SUMMARY_TEXT),
    description: 'the executor claims the triage summary was drafted (a claim, not proof of the side effect)',
  });
  check(
    '2.evidence-claim',
    claimEvidence.statusCode === 201,
    `claim evidence recorded as class claim (a model/executor assertion is NEVER observation or verification evidence — constitution §7)`,
  );

  // observation evidence: a REAL fs observation of the real draft artifact
  const draftObservationCommitment = executionValueCommitment(observationRecordOf(draftSummaryFile));
  const obsEvidence = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/evidence`, {
    commandId: 'cmd-dogfood-0014',
    correlationId: CORRELATION,
    evidenceClass: 'observation',
    producerKind: 'executor',
    producerId: V2_004_EVIDENCE_NODE_ID,
    contentCommitment: draftObservationCommitment,
    description: 'observed draft-summary.txt on the execution host (real fs stat observation, real sha-256)',
  });
  check(
    '2.evidence-observation',
    obsEvidence.statusCode === 201 && draftObservationCommitment === executionValueCommitment(observationRecordOf(draftSummaryFile)),
    `observation evidence recorded from a REAL local artifact observation (${norm(draftObservationCommitment)} — real sha-256 over the real fs observation record)`,
  );
  const obsTimeline = (await inject(app1, 'GET', `/workflow-runs/runs/${runId}/history`)).json() as {
    timeline: { eventName: string }[];
  };
  check(
    '2.observation-projects-registry-event',
    obsTimeline.timeline.map((e) => e.eventName).includes('observation.recorded'),
    `the observation evidence projects the registry event observation.recorded into the timeline`,
  );

  // review_gate: the human approval (real approval-record artifact + human_confirmation evidence)
  const approvalRecordFile = join(runDir, 'approval-record.json');
  writeFileSync(approvalRecordFile, APPROVAL_RECORD, 'utf8');
  const approvalCommitment = executionValueCommitment(readFileSync(approvalRecordFile));
  const reviewStarted = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/steps/review_gate/started`, {
    commandId: 'cmd-dogfood-0015-a',
    correlationId: CORRELATION,
  });
  check(
    '2.step-started-review_gate',
    reviewStarted.statusCode === 200,
    `step review_gate started (the DECLARED human-approval step)`,
  );
  const humanEvidence = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/evidence`, {
    commandId: 'cmd-dogfood-0016',
    correlationId: CORRELATION,
    attemptNumber: 1,
    stepId: 'review_gate',
    evidenceClass: 'human_confirmation',
    producerKind: 'human',
    producerId: 'v2-005-dogfood-operator',
    contentCommitment: approvalCommitment,
    description: 'the operator approved posting the triage summary (real approval record)',
  });
  check(
    '2.evidence-human-confirmation',
    humanEvidence.statusCode === 201,
    `human_confirmation evidence recorded (class human_confirmation, producer human/operator, real approval-record commitment ${norm(approvalCommitment)})`,
  );
  const reviewDone = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/steps/review_gate/completed`, {
    commandId: 'cmd-dogfood-0017-d',
    correlationId: CORRELATION,
    outcome: 'succeeded',
    outputCommitments: [approvalCommitment],
  });
  check(
    '2.step-completed-review_gate',
    reviewDone.statusCode === 200,
    `step review_gate completed (succeeded, approved)`,
  );

  // === 3. PAUSE MID-RUN, RESUME TO THE EXACT STEP ===========================

  section('3. pause mid-run at notify_channel (before the crash)');
  const pauseBody = {
    commandId: 'cmd-dogfood-0018',
    correlationId: CORRELATION,
    atStepId: 'notify_channel',
  };
  const pauseRes = await inject(app1, 'POST', `/workflow-runs/runs/${runId}/pause`, pauseBody);
  const paused = pauseRes.json() as {
    run: { state: string };
    attempt: { attemptNumber: number; state: string; pausedAtStepId: string | null };
  };
  check(
    '3.pause-mid-run',
    pauseRes.statusCode === 200 && paused.run.state === 'paused' &&
      paused.attempt.state === 'suspended' && paused.attempt.pausedAtStepId === 'notify_channel',
    `POST /pause 200 — run PAUSED, attempt #1 suspended AT step notify_channel (the exact recorded resume point)`,
  );

  // === 4. CRASH: dispose the service instance + app mid-run =================

  section('4. CRASH — service instance destroyed mid-run; FRESH instance over the same database');
  await app1.close();

  const app2 = await buildApp();

  // post-crash duplicate command: the SAME pause command id replays
  const crashReplay = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/pause`, pauseBody);
  const crashReplayBody = crashReplay.json() as {
    run: { state: string };
    attempt: { state: string; pausedAtStepId: string | null };
    executed: boolean;
  };
  check(
    '4.post-crash-duplicate-command-converges',
    crashReplay.statusCode === 200 && !crashReplayBody.executed &&
      crashReplayBody.run.state === 'paused' && crashReplayBody.attempt.pausedAtStepId === 'notify_channel',
    `post-crash replay of the pause command id → 200, executed=false (converged on the recorded outcome; NO second side effect)`,
  );

  const resumeRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/resume`, {
    commandId: 'cmd-dogfood-0019',
    correlationId: CORRELATION,
    nodeId: V2_004_EVIDENCE_NODE_ID,
  });
  const resumed = resumeRes.json() as {
    run: { state: string };
    attempt: { attemptNumber: number; state: string };
    resumedAtStepId: string | null;
    newAttempt: boolean;
  };
  check(
    '4.fresh-instance-resumes-to-exact-step',
    resumeRes.statusCode === 200 && resumed.run.state === 'running' &&
      resumed.resumedAtStepId === 'notify_channel' && !resumed.newAttempt &&
      resumed.attempt.attemptNumber === 1 && resumed.attempt.state === 'running',
    `the FRESH instance RESUMED the reconstructed run to the EXACT step notify_channel (same attempt #1, newAttempt=false — resume is not a restart)`,
  );

  // notify_channel: the real message delivery (attested below)
  const notifyPayloadFile = join(runDir, 'notify-payload.txt');
  writeFileSync(notifyPayloadFile, NOTIFY_PAYLOAD, 'utf8');
  await driveStep(app2, 'notify_channel', 'messaging.send', 'deterministic_api', 'cmd-dogfood-0020', [
    executionValueCommitment(readFileSync(notifyPayloadFile)),
  ]);

  const notifyObservation = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/evidence`, {
    commandId: 'cmd-dogfood-0024',
    correlationId: CORRELATION,
    evidenceClass: 'observation',
    producerKind: 'executor',
    producerId: V2_004_EVIDENCE_NODE_ID,
    contentCommitment: executionValueCommitment(observationRecordOf(notifyPayloadFile)),
    description: 'observed notify-payload.txt on the execution host (real fs stat observation, real sha-256)',
  });
  check(
    '4.evidence-observation-notify',
    notifyObservation.statusCode === 201,
    `post-crash observation evidence recorded for the delivered notification artifact (class observation, distinct from the claim)`,
  );

  // === 5. REAL EXECUTION ATTESTATION (V2-014 barrel, real Ed25519) ==========

  section('5. produce + attach a REAL V2-014 ExecutionAttestation (real Ed25519, real artifacts)');
  // real reference data for the statement bindings
  const runRead = (await inject(app2, 'GET', `/workflow-runs/runs/${runId}`)).json() as {
    run: {
      id: string; workflowId: string; versionId: string; versionSemanticDigest: string;
      installationId: string | null;
    };
  };
  const historyForStatement = (await inject(app2, 'GET', `/workflow-runs/runs/${runId}/history`)).json() as {
    evidence: { id: string; evidenceClass: string }[];
  };
  const evidenceReferences = historyForStatement.evidence
    .filter((e) => e.evidenceClass === 'observation' || e.evidenceClass === 'human_confirmation')
    .map((e) => e.id);

  const notifyOutputCommitment = executionValueCommitment(readFileSync(notifyPayloadFile));
  const notifyObservationCommitment = executionValueCommitment(observationRecordOf(notifyPayloadFile));

  // the causal parent: the review_gate approval execution fact (V2-014 precedent)
  const parentStatement: ExecutionStatement = {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId: runRead.run.workflowId,
    workflowVersionId: runRead.run.versionId,
    workflowVersionSemanticDigest: runRead.run.versionSemanticDigest,
    deploymentId: runRead.run.installationId as string,
    runId: runRead.run.id,
    attemptId: 1,
    stepId: 'review_gate',
    nodeId: V2_004_EVIDENCE_NODE_ID,
    workloadIdentity: WORKLOAD_IDENTITY,
    executionClass: 'human',
    action: 'Human review gate: approve posting the triage summary and syncing the backlog',
    inputCommitments: [executionValueCommitment(readFileSync(draftSummaryFile))],
    outputCommitments: [approvalCommitment],
    observationCommitments: [executionValueCommitment(observationRecordOf(approvalRecordFile))],
    evidenceReferences,
    causalParents: [],
    nonce: 'challenge-v2-005-dogfood-review-gate-1',
    epoch: EPOCH,
    outcome: 'succeeded',
    executedAt: EXECUTED_AT,
    validUntil: VALID_UNTIL,
  };
  const parentDigest = computeExecutionDigest(parentStatement);

  // the attested statement: the notify_channel execution fact, bound to the EXACT run/attempt/step
  const statement: ExecutionStatement = {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId: runRead.run.workflowId,
    workflowVersionId: runRead.run.versionId,
    workflowVersionSemanticDigest: runRead.run.versionSemanticDigest,
    deploymentId: runRead.run.installationId as string,
    runId: runRead.run.id,
    attemptId: 1,
    stepId: 'notify_channel',
    nodeId: V2_004_EVIDENCE_NODE_ID,
    workloadIdentity: WORKLOAD_IDENTITY,
    executionClass: 'deterministic_api',
    capability: 'messaging.send',
    action: 'Post the approved triage summary to the team notifications channel',
    inputCommitments: [executionValueCommitment(readFileSync(draftSummaryFile))],
    outputCommitments: [notifyOutputCommitment],
    observationCommitments: [notifyObservationCommitment],
    evidenceReferences,
    causalParents: [parentDigest.digest],
    authorizationContextDigest: executionValueCommitment(
      'authorization: operator v2-005-dogfood-operator may post approved triage summaries to team-notifications',
    ),
    placementPolicyDigest: executionValueCommitment(
      'placement: notify_channel requires cloud_preferred placement per the pinned WorkflowVersion',
    ),
    nonce: 'challenge-v2-005-dogfood-run-0001-attempt-1',
    epoch: EPOCH,
    outcome: 'succeeded',
    executedAt: EXECUTED_AT,
    validUntil: VALID_UNTIL,
  };
  const statementValidation = validateExecutionStatement(statement);
  check(
    '5.statement-validates',
    statementValidation.ok,
    statementValidation.ok
      ? 'the composed statement validates against the V2-014 schema (bound to the EXACT run/attempt/step/version/deployment, real artifact commitments, real causal parent)'
      : JSON.stringify(statementValidation.issues),
  );

  const attester = generateAttesterKeyPair();
  const attestation = signExecutionAttestation({
    statement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: ISSUED_AT,
  });
  const attestationBytes = serializeAttestation(attestation);
  check(
    '5.attestation-privacy',
    attestationBytes.includes(notifyOutputCommitment) &&
      !attestationBytes.includes('TRIAGE-CARD-77f3e') && !attestationBytes.includes('team-notifications@secrets'),
    `real Ed25519 attestation produced (${attestationBytes.length} canonical chars); the bytes carry the artifact COMMITMENT, never the payload text or the secret ref`,
  );
  say(`attestation identity ${norm(attestation.attestationId)} (attester key ${norm(attestation.attesterKeyId)}, assurance software_signed)`);
  say(`ExecutionDigest ${norm(attestation.executionDigest.digest)} (domain ${attestation.executionDigest.domain})`);
  say(`causal parent ExecutionDigest ${norm(parentDigest.digest)} (the review_gate approval fact)`);

  const attachBody = {
    commandId: 'cmd-dogfood-0025',
    correlationId: CORRELATION,
    attemptNumber: 1,
    stepId: 'notify_channel',
    attestation: JSON.parse(attestationBytes) as unknown,
    policy: { trustedAttesterKeyIds: [attester.keyId] },
  };
  const attachRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/attestations`, attachBody);
  const attached = attachRes.json() as {
    binding: {
      attestationId: string; runId: string; attemptNumber: number; stepId: string | null;
      executionDigest: string; attesterKeyId: string; assurance: string; nonce: string;
    };
    evidence: { evidenceClass: string; contentCommitment: string };
    executed: boolean;
  };
  check(
    '5.attach-attestation',
    attachRes.statusCode === 201 && attached.executed &&
      attached.binding.attestationId === attestation.attestationId &&
      attached.binding.runId === runId && attached.binding.attemptNumber === 1 &&
      attached.binding.stepId === 'notify_channel' &&
      attached.binding.executionDigest === attestation.executionDigest.digest &&
      attached.binding.attesterKeyId === attestation.attesterKeyId &&
      attached.binding.assurance === 'software_signed' &&
      attached.binding.nonce === 'challenge-v2-005-dogfood-run-0001-attempt-1',
    `POST /attestations 201 — the Run boundary VERIFIED the digest, the run/attempt/step binding, and freshness, then recorded the binding (${norm(attestation.attestationId)})`,
  );
  check(
    '5.attach-records-verification-evidence',
    attached.evidence.evidenceClass === 'verification' && attached.evidence.contentCommitment === attestation.executionDigest.digest,
    `the attach recorded DISTINCT verification-class evidence (content commitment = the ExecutionDigest — one-way by V2-014 construction)`,
  );

  // === 6. NEGATIVE EXPERIMENTS — all typed, none become verification evidence

  section('6. negative experiments (modified / mismatched / replayed / stale — ALL typed)');

  // (a) MODIFIED: a REAL signed attestation whose statement is then modified
  //     IN TRANSIT (after signing, without re-signing) — the envelope's
  //     ExecutionDigest + Ed25519 signature were computed over the ORIGINAL
  //     canonical statement bytes, so the modified delivery fails closed.
  const modifiedBaseStatement: ExecutionStatement = {
    ...statement,
    nonce: 'challenge-v2-005-dogfood-run-0001-modified',
    causalParents: [parentDigest.digest],
  };
  const modifiedSigned = signExecutionAttestation({
    statement: modifiedBaseStatement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: ISSUED_AT,
  });
  const modifiedAttestation = JSON.parse(serializeAttestation(modifiedSigned)) as { statement: Record<string, unknown> } & Record<string, unknown>;
  modifiedAttestation.statement = { ...modifiedAttestation.statement, action: 'MUTATED action text' };
  const modifiedRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/attestations`, {
    ...attachBody,
    commandId: 'cmd-dogfood-0026',
    attestation: modifiedAttestation,
  });
  check(
    '6a.modified-attestation-rejected',
    modifiedRes.statusCode === 422 && (modifiedRes.json() as { code: string }).code === 'RUN_ATTESTATION_REJECTED',
    `MODIFIED attestation (a real attestation whose statement was mutated after signing, never re-signed) → 422 RUN_ATTESTATION_REJECTED (typed; the digest/signature no longer commit to the delivered statement; never attached)`,
  );

  // (b) MISMATCHED: a REAL attestation bound to a DIFFERENT run (a real second run)
  const run2Request = await inject(app2, 'POST', `/organizations/${org.id}/workflow-runs/runs`, {
    commandId: 'cmd-dogfood-0027',
    correlationId: 'delivery-v2-005-dogfood-0002',
    workflowId,
    versionId: version1Id,
    trigger: { type: 'webhook', id: 'delivery-v2-005-dogfood-0002' },
    inputCommitments: [executionValueCommitment('another inbound issue')],
  });
  const run2Id = (run2Request.json() as { run: { id: string } }).run.id;
  const mismatchedStatement: ExecutionStatement = {
    ...statement,
    runId: run2Id,
    nonce: 'challenge-v2-005-dogfood-run-0002-attempt-1',
    causalParents: [parentDigest.digest],
  };
  const mismatchedAttestation = signExecutionAttestation({
    statement: mismatchedStatement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: ISSUED_AT,
  });
  const mismatchedRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/attestations`, {
    ...attachBody,
    commandId: 'cmd-dogfood-0028',
    attestation: JSON.parse(serializeAttestation(mismatchedAttestation)) as unknown,
  });
  check(
    '6b.mismatched-attestation-rejected',
    mismatchedRes.statusCode === 422 && (mismatchedRes.json() as { code: string }).code === 'RUN_ATTESTATION_REJECTED',
    `MISMATCHED attestation (a REAL second attestation bound to run ${norm(run2Id)}, attached to run ${norm(runId)}) → 422 typed rejection (the statement's run identity must match the record it is attached to)`,
  );

  // (c) REPLAY: the SAME valid attestation attached again
  const replayRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/attestations`, {
    ...attachBody,
    commandId: 'cmd-dogfood-0029',
  });
  check(
    '6c.replayed-attestation-rejected',
    replayRes.statusCode === 422 && (replayRes.json() as { code: string }).code === 'RUN_ATTESTATION_REJECTED',
    `the SAME valid attestation again → typed RUN_ATTESTATION_REJECTED with the durable failureCode ATTESTATION_REPLAYED (single-use consumption: the persisted binding row IS the nonce consumption)`,
  );
  // durability: a FRESH service instance also rejects (replay state is in the DB, not memory)
  const freshBoundaryService = new DefaultWorkflowRunService({
    db,
    memberships,
    workflowRepository: repository,
    clock,
    currentEpoch: EPOCH,
  });
  let freshInstanceRejected = false;
  try {
    await freshBoundaryService.attachAttestation(
      { userId: operator.id },
      { commandId: 'cmd-dogfood-0032', correlationId: CORRELATION },
      {
        runId,
        attemptNumber: 1,
        stepId: 'notify_channel',
        attestation: JSON.parse(attestationBytes) as never,
      },
    );
  } catch {
    freshInstanceRejected = true;
  }
  check(
    '6c.durable-replay-across-instances',
    freshInstanceRejected,
    `a FRESH service instance also rejects the replayed attestation (durable replay state — V2-014's InMemoryReplayRegistry was reference-only; durable single-use state is V2-005's)`,
  );

  // (d) STALE: a fresh attestation whose validity window has expired
  const staleStatement: ExecutionStatement = {
    ...statement,
    nonce: 'challenge-v2-005-dogfood-run-0001-stale',
    causalParents: [parentDigest.digest],
  };
  const staleAttestation = signExecutionAttestation({
    statement: staleStatement,
    attesterPrivateKey: attester.privateKey,
    attesterPublicKeyDer: attester.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: ISSUED_AT,
  });
  clock.setNow(STALE_NOW);
  const staleRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/attestations`, {
    ...attachBody,
    commandId: 'cmd-dogfood-0030',
    attestation: JSON.parse(serializeAttestation(staleAttestation)) as unknown,
  });
  clock.clearOverride();
  check(
    '6d.stale-attestation-rejected',
    staleRes.statusCode === 422 && (staleRes.json() as { code: string }).code === 'RUN_ATTESTATION_REJECTED',
    `STALE attestation (validity expired at ${VALID_UNTIL}; boundary clock ${STALE_NOW}) → 422 typed rejection (freshness is mandatory — timestamps alone are not a replay defense)`,
  );

  // === 7. UNAUTHORIZED completion (another tenant) THEN authorized complete ==

  section('7. unauthorized completion attempt (cross-tenant) → typed 404; then authorized complete');
  const outsiderRead = await inject(app2, 'GET', `/workflow-runs/runs/${runId}`, undefined, OUTSIDER_KEY);
  check(
    '7.cross-tenant-read-uniform-404',
    outsiderRead.statusCode === 404 && (outsiderRead.json() as { error: string }).error === 'workflow-run-not-found',
    `cross-tenant run read → uniform 404 workflow-run-not-found (zero existence leakage)`,
  );
  const outsiderComplete = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/complete`, {
    commandId: 'cmd-dogfood-outsider-complete',
    correlationId: 'delivery-outsider-0001',
  }, OUTSIDER_KEY);
  check(
    '7.unauthorized-completion-rejected',
    outsiderComplete.statusCode === 404 && (outsiderComplete.json() as { code: string }).code === 'RUN_NOT_FOUND',
    `UNAUTHORIZED completion from the other tenant → typed 404 RUN_NOT_FOUND; the run state is untouched`,
  );
  const stateAfterOutsider = (await inject(app2, 'GET', `/workflow-runs/runs/${runId}`)).json() as { run: { state: string } };
  check(
    '7.run-state-untouched',
    stateAfterOutsider.run.state === 'running',
    `operator re-read: the run is still running (the rejected command left no trace on the lifecycle)`,
  );

  const messageIdFile = join(runDir, 'message-id.json');
  writeFileSync(messageIdFile, MESSAGE_ID_RECORD, 'utf8');
  const completeRes = await inject(app2, 'POST', `/workflow-runs/runs/${runId}/complete`, {
    commandId: 'cmd-dogfood-0031',
    correlationId: CORRELATION,
    outputCommitments: [executionValueCommitment(readFileSync(messageIdFile))],
  });
  const completed = completeRes.json() as {
    run: { state: string };
    attempt: { attemptNumber: number; state: string } | null;
  };
  check(
    '7.authorized-completion',
    completeRes.statusCode === 200 && completed.run.state === 'completed' &&
      completed.attempt !== null && completed.attempt.state === 'ended',
    `authorized completion → 200; run COMPLETED (terminal), attempt #1 ended (the claimed output is a commitment, never raw output)`,
  );

  // === 8. RECONSTRUCT the execution history from the persisted Run alone ====

  section('8. reconstruct the execution history from the persisted Run alone (fresh instance + fresh route read)');
  const routeHistoryRes = await inject(app2, 'GET', `/workflow-runs/runs/${runId}/history`);
  const routeHistory = routeHistoryRes.json() as {
    run: { id: string; state: string };
    timeline: { eventName: string; attemptNumber: number | null; stepId: string | null; sequence: number }[];
    attempts: { attemptNumber: number; state: string; pausedAtStepId: string | null }[];
    steps: { attemptNumber: number; stepId: string; status: string; outcome: string | null }[];
    invocations: { attemptNumber: number; stepId: string | null; capability: string; executionClass: string; outcome: string | null }[];
    evidence: { evidenceClass: string; producerKind: string; producerId: string; contentCommitment: string }[];
    attestations: { attemptNumber: number; stepId: string | null; executionDigest: string; attesterKeyId: string; assurance: string; nonce: string }[];
    attestationRejections: { failureCode: string }[];
    commands: { commandId: string; commandType: string; result: { ok: boolean; code?: string } }[];
  };

  // the FRESH instance (a brand-new service object over the same database)
  const reconstructionService = new DefaultWorkflowRunService({
    db,
    memberships,
    workflowRepository: repository,
    clock,
    currentEpoch: EPOCH,
  });
  const moduleHistory = await reconstructionService.getRunHistory({ userId: operator.id }, runId);

  /** The structural input shared by both reconstruction reads. */
  interface HistoryProjectionInput {
    run: { id: string; state: string };
    timeline: { eventName: string; attemptNumber: number | null; stepId: string | null }[];
    attempts: { attemptNumber: number; state: string; pausedAtStepId: string | null }[];
    steps: { attemptNumber: number; stepId: string; status: string; outcome: string | null }[];
    invocations: { attemptNumber: number; stepId: string | null; capability: string; executionClass: string; outcome: string | null }[];
    evidence: { evidenceClass: string; producerKind: string; producerId: string; contentCommitment: string }[];
    attestations: { attemptNumber: number; stepId: string | null; executionDigest: string; attesterKeyId: string; assurance: string; nonce: string }[];
    attestationRejections: { failureCode: string }[];
    commands: { commandId: string; commandType: string; result: { ok: boolean; code?: string } }[];
  }

  /** The canonical reconstruction projection (identical for both reads). */
  const project = (h: HistoryProjectionInput): string =>
    JSON.stringify({
      run: [h.run.id, h.run.state],
      timeline: h.timeline.map((e) => [e.eventName, e.attemptNumber, e.stepId]),
      attempts: h.attempts.map((a) => [a.attemptNumber, a.state, a.pausedAtStepId]),
      steps: h.steps.map((s) => [s.attemptNumber, s.stepId, s.status, s.outcome]),
      invocations: h.invocations.map((i) => [i.attemptNumber, i.stepId, i.capability, i.executionClass, i.outcome]),
      evidence: h.evidence.map((e) => [e.evidenceClass, e.producerKind, e.producerId, norm(e.contentCommitment)]),
      attestations: h.attestations.map((b) => [b.attemptNumber, b.stepId, norm(b.executionDigest), norm(b.attesterKeyId), b.assurance, b.nonce]),
      rejections: h.attestationRejections.map((r) => r.failureCode),
      commands: h.commands.map((c) => [c.commandId, c.commandType, c.result.ok, c.result.ok ? undefined : c.result.code]),
    });

  const moduleHistoryJson = {
    run: { id: moduleHistory.run.id, state: moduleHistory.run.state },
    timeline: moduleHistory.timeline.map((e) => ({
      eventName: e.eventName, attemptNumber: e.attemptNumber, stepId: e.stepId, sequence: e.sequence,
    })),
    attempts: moduleHistory.attempts.map((a) => ({
      attemptNumber: a.attemptNumber, state: a.state, pausedAtStepId: a.pausedAtStepId,
    })),
    steps: moduleHistory.steps.map((s) => ({
      attemptNumber: s.attemptNumber, stepId: s.stepId, status: s.status, outcome: s.outcome,
    })),
    invocations: moduleHistory.invocations.map((i) => ({
      attemptNumber: i.attemptNumber, stepId: i.stepId, capability: i.capability,
      executionClass: i.executionClass, outcome: i.outcome,
    })),
    evidence: moduleHistory.evidence.map((e) => ({
      evidenceClass: e.evidenceClass, producerKind: e.producerKind, producerId: e.producerId,
      contentCommitment: e.contentCommitment,
    })),
    attestations: moduleHistory.attestations.map((b) => ({
      attemptNumber: b.attemptNumber, stepId: b.stepId, executionDigest: b.executionDigest,
      attesterKeyId: b.attesterKeyId, assurance: b.assurance, nonce: b.nonce,
    })),
    attestationRejections: moduleHistory.attestationRejections.map((r) => ({ failureCode: r.failureCode })),
    commands: moduleHistory.commands.map((c) => ({
      commandId: c.commandId, commandType: c.commandType, result: c.result as { ok: boolean; code?: string },
    })),
  } as HistoryProjectionInput;

  check(
    '8.fresh-instance-reconstruction-equals-route-read',
    project(routeHistory) === project(moduleHistoryJson),
    `a FRESH service instance over the same database reconstructed the history EXACTLY equal to the route read (run, timeline, attempts, steps, invocations, evidence, attestations, rejections, commands)`,
  );
  check(
    '8.reconstruction-run-state',
    routeHistory.run.state === 'completed' && routeHistory.run.id === runId,
    `the reconstructed run is the same durable identity ${norm(runId)} in terminal state completed`,
  );

  const expectedTimeline = [
    'workflow.run.requested',
    'workflow.run.started',
    'workflow.step.started',
    'capability.invocation.requested',
    'capability.invocation.completed',
    'workflow.step.completed',
    'workflow.step.started',
    'capability.invocation.requested',
    'capability.invocation.completed',
    'workflow.step.completed',
    'observation.recorded',
    'workflow.step.started',
    'workflow.step.completed',
    'workflow.run.paused',
    'workflow.run.resumed',
    'workflow.step.started',
    'capability.invocation.requested',
    'capability.invocation.completed',
    'workflow.step.completed',
    'observation.recorded',
    'execution.attestation.verified',
    'verification.completed',
    'workflow.run.completed',
  ];
  const actualTimeline = routeHistory.timeline.map((e) => e.eventName);
  check(
    '8.timeline-reconstructed-in-order',
    JSON.stringify(actualTimeline) === JSON.stringify(expectedTimeline),
    `the reconstructed state timeline (registry event names, in order): ${actualTimeline.join(' → ')}`,
  );

  check(
    '8.attempts-reconstructed',
    routeHistory.attempts.length === 1 &&
      routeHistory.attempts[0]!.attemptNumber === 1 && routeHistory.attempts[0]!.state === 'ended',
    `one execution attempt reconstructed (attempt #1: running → suspended(at notify_channel) → running → ended with the run)`,
  );

  const expectedSteps = [
    ['fetch_issue', 'completed'],
    ['draft_summary', 'completed'],
    ['review_gate', 'completed'],
    ['notify_channel', 'completed'],
  ];
  check(
    '8.steps-reconstructed-in-flow-order',
    JSON.stringify(routeHistory.steps.map((s) => [s.stepId, s.status])) === JSON.stringify(expectedSteps) &&
      routeHistory.steps.every((s) => s.attemptNumber === 1 && s.outcome === 'succeeded'),
    `the declared steps reconstructed in flow order, all completed/succeeded: ${routeHistory.steps.map((s) => s.stepId).join(' → ')}`,
  );

  const expectedInvocations = [
    ['github.repository.read', 'deterministic_api'],
    ['github.repository.read', 'agentic_computer_use'],
    ['messaging.send', 'deterministic_api'],
  ];
  check(
    '8.invocations-reconstructed-canonical',
    JSON.stringify(routeHistory.invocations.map((i) => [i.capability, i.executionClass])) === JSON.stringify(expectedInvocations) &&
      routeHistory.invocations.every((i) => i.outcome === 'succeeded' && i.attemptNumber === 1),
    `capability invocations reconstructed with canonical registry names + the four registry execution classes: ${routeHistory.invocations.map((i) => `${i.capability}(${i.executionClass})`).join(', ')}`,
  );

  const expectedEvidenceClasses = [
    'intent', 'claim', 'observation', 'human_confirmation', 'observation', 'verification',
  ];
  check(
    '8.evidence-reconstructed-with-classes-and-provenance',
    JSON.stringify(routeHistory.evidence.map((e) => e.evidenceClass)) === JSON.stringify(expectedEvidenceClasses) &&
      routeHistory.evidence.every((e) => e.producerKind.length > 0 && e.producerId.length > 0),
    `evidence reconstructed with DISTINCT classes + provenance: ${routeHistory.evidence.map((e) => `${e.evidenceClass}@${e.producerKind}`).join(', ')}`,
  );

  check(
    '8.attestation-binding-reconstructed',
    routeHistory.attestations.length === 1 &&
      routeHistory.attestations[0]!.attemptNumber === 1 &&
      routeHistory.attestations[0]!.stepId === 'notify_channel' &&
      routeHistory.attestations[0]!.assurance === 'software_signed' &&
      routeHistory.attestations[0]!.executionDigest === attestation.executionDigest.digest &&
      routeHistory.attestations[0]!.attesterKeyId === attestation.attesterKeyId,
    `the attestation binding reconstructed: bound to attempt #1 / step notify_channel with the verified ExecutionDigest + attester key identity`,
  );

  const expectedRejections = [
    'ATTESTATION_DIGEST_MISMATCH',
    'ATTESTATION_SIGNATURE_INVALID',
    'ATTESTATION_BINDING_MISMATCH',
    'ATTESTATION_REPLAYED',
    'ATTESTATION_REPLAYED',
    'ATTESTATION_EXPIRED',
  ];
  const rejectionCodes = routeHistory.attestationRejections.map((r) => r.failureCode);
  check(
    '8.typed-rejections-reconstructed',
    rejectionCodes.length === 5 &&
      (rejectionCodes[0] === expectedRejections[0] || rejectionCodes[0] === expectedRejections[1]) &&
      rejectionCodes.slice(1).join(',') === [expectedRejections[2], expectedRejections[3], expectedRejections[4], expectedRejections[5]].join(','),
    `all typed boundary rejections reconstructed durably: ${rejectionCodes.join(', ')} (append-only audit — never erased, never evidence)`,
  );
  check(
    '8.no-negative-became-verification-evidence',
    routeHistory.evidence.filter((e) => e.evidenceClass === 'verification').length === 1,
    `exactly ONE verification-class evidence record exists (the valid attach); no modified/mismatched/replayed/stale attestation became verification evidence`,
  );

  const commandIds = routeHistory.commands.map((c) => c.commandId);
  const pauseCommands = routeHistory.commands.filter((c) => c.commandType === 'pause_run');
  const rejectedCommands = routeHistory.commands.filter((c) => !c.result.ok);
  check(
    '8.command-log-proves-exactly-once',
    commandIds.length === 31 &&
      new Set(commandIds).size === commandIds.length &&
      pauseCommands.length === 1 &&
      pauseCommands[0]!.result.ok === true &&
      rejectedCommands.length === 5 &&
      rejectedCommands.every((c) => c.result.code === 'RUN_ATTESTATION_REJECTED'),
    `the command log reconstructs 31 distinct exactly-once commands (replayed command ids converged — ONE pause_run; the 5 rejected attach commands are durably typed)`,
  );
  say(`reconstructed command types: ${[...new Set(routeHistory.commands.map((c) => c.commandType))].join(', ')}`);

  // --- teardown ---------------------------------------------------------------

  await app2.close();
  await db.close();

  return { label, lines, failures };
}

// ---------------------------------------------------------------------------
// Run the whole experiment TWICE + determinism comparison (V2-006 precedent)
// ---------------------------------------------------------------------------

const wallStartedAt = Date.now();

process.env['WFOS_V2_005_DOGFOOD_OPERATOR_KEY'] = OPERATOR_KEY;
process.env['WFOS_V2_005_DOGFOOD_OUTSIDER_KEY'] = OUTSIDER_KEY;

const run1 = await executeExperiment('run-1');
const run2 = await executeExperiment('run-2');

const out: string[] = [];
out.push('V2-005 workflow runs + evidence dogfooding run');
out.push('work order: V2-005 (workflow runs + evidence)');
out.push('tested module: backend/src/workflow-runs (PostgreSQL-authoritative run state + evidence; routes over the real Fastify buildServer)');
out.push(`wall clock start (ms): ${String(wallStartedAt)}`);
out.push(...run1.lines);
out.push(...run2.lines);

// determinism: identical transcripts after normalizing the run label
const deLabel = (text: string): string => text.replace(/run-1/g, 'the-run').replace(/run-2/g, 'the-run');
const transcript1 = deLabel(run1.lines.join('\n'));
const transcript2 = deLabel(run2.lines.join('\n'));
const deterministic = transcript1 === transcript2;

out.push('');
out.push('--- determinism (the whole experiment run twice; fresh PGlite + fresh identity stack + fresh Ed25519 key pair per run)');
out.push(
  deterministic
    ? '  [ok]   determinism — the two transcripts are IDENTICAL after normalizing run-scoped bookkeeping (uuid-derived org/workflow/version/installation ids, run-derived ids, key-derived attestation material); every state transition, event order, evidence class, typed rejection, and reconstruction projection is byte-stable'
    : '  [FAIL] determinism — the two transcripts differ after normalization',
);
const totalFailures = run1.failures.length + run2.failures.length + (deterministic ? 0 : 1);
out.push('');
out.push(
  totalFailures === 0
    ? 'RESULT: a real workflow executed, paused/resumed to the exact step through a fresh instance after a mid-run crash, a REAL attestation attached through the verified Run boundary, all negative experiments typed, the execution history reconstructed exactly from the persisted Run alone, determinism proven'
    : `RESULT: ${totalFailures} assertion(s) FAILED`,
);
out.push(`wall duration (ms): ${String(Date.now() - wallStartedAt)}`);
out.push(
  'OBSERVATION (scope, not failure): no real PostgreSQL server is reachable in this sandbox (PGlite is real PostgreSQL compiled to WASM — the same single persistence boundary; true multi-connection contention runs in the env-gated real-PG CI workflow, mirrored by the env-gated concurrency regression). The executor harness is the module\'s own command surface driven over the real routes (real computer-use execution is V2-008; scheduling/events are V2-009) — the Run records what the commanded execution path reports, and the attestation binds it. The operator is the implementing agent. Attestation semantics are V2-014\'s frozen contract (consumed through the merged verifier; durable single-use replay state is V2-005\'s, as the persisted V2-014 evidence limitation requires).',
);
out.push(
  'DETERMINISM NOTE: re-running this harness yields identical transcripts after normalizing run-scoped bookkeeping (the uuid-derived repository identities and the run ids they pin, key-derived attestation identities/digests/signatures, and wall duration); the pinned WorkflowVersion semantic digest and all real artifact commitments are cross-run-stable constants asserted in-code.',
);

process.stdout.write(`${out.join('\n')}\n`);
process.exit(totalFailures === 0 ? 0 : 1);
